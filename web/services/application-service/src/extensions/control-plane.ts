/**
 * 站点插件控制面：prepare → 版本化 commit → activation → reconcile
 * （change: 2026-10-05-extract-application-plugin-host，任务 3.2 / design D4/D6）。
 *
 * 关键语义（design D4/D5/D6）：
 * - 更新先**校验并 prepare** 候选（不产生对外可用资源），再执行带版本检查的持久化提交；
 * - 提交前失败保留旧配置；提交后若 activation 失败，保存目标版本与 failed/degraded 实际状态，
 *   并**禁止伪称已回滚**（target 与实际状态分开公开）；
 * - 进程在 commit 后崩溃由**启动 reconciliation** 完成（依据已提交版本重建实际状态）；
 * - 提交后 admission 按已提交版本切换；activation 完成前显示 configuring 并拒绝新工作。
 * - 运行实例按 `(extensionId, configVersion)` 管理；被引用的旧版本必须保留到引用清零。
 *
 * 本模块只负责站点配置生命周期；真实插件由 fixture/后续 change 注入。
 */
import type {
  ApplicationBackendExtensionHealth,
  ApplicationExtensionActualState,
  ApplicationExtensionMetadata,
  ApplicationExtensionStatus
} from "@woohaa3/contracts";
import { awaitActivationWithDeadline, resolveActivationTimeout } from "./activation-deadline.js";
import { createQuarantineOperations, fallbackDiagnostics, heldStateOf, prepareCandidate } from "./control-plane-states.js";
import { createRuntimeCatalog, createRuntimeRegistration } from "./control-plane-runtime.js";
import type { SiteExtensionControlPlane, SiteExtensionControlPlaneOptions } from "./control-plane-types.js";
import { createQuarantineRegistry } from "./quarantine.js";
import { createExtensionWorkLease, type ExtensionWorkLease } from "./work.js";

export type * from "./control-plane-types.js";
export { DEFAULT_SITE_ACTIVATION_TIMEOUT_MS } from "./activation-deadline.js";

export function createSiteExtensionControlPlane(options: SiteExtensionControlPlaneOptions): SiteExtensionControlPlane {
  const now = options.now ?? (() => new Date());
  const log = options.logger ?? (() => undefined);
  const definitionById = new Map(options.definitions.map((definition) => [definition.extensionId, definition]));
  // 启动期清单之上叠加运行期登记（control-plane-runtime.ts）；以下一律经 catalog 读元数据。
  const catalog = createRuntimeCatalog(options.metadata);
  // 必需基础提供者的 owner extension（任务 1.5）：在线停用一律拒绝，必须经发布/重启更新 profile。
  const requiredProviderOwners = new Set((options.requiredProviders ?? []).map((profile) => profile.extensionId));
  const suspended = options.suspended ?? new Set<string>();
  const leases = new Map<string, ExtensionWorkLease>();
  // 隔离记录从审计恢复（重启后仍隔离）；优先级见 quarantine.ts。
  const quarantine = createQuarantineRegistry(
    catalog.source.list().map((metadata) => metadata.extensionId),
    (extensionId) => options.store.audit(extensionId, 200)
  );
  /** extensionId -> 当前 public 实例的配置版本（undefined 表示未激活公共实例）。 */
  const publicVersion = new Map<string, number>();

  /**
   * 目标启用状态：以配置文件的 `extensions.<id>.enabled` 为准（注入 `toggles` 时），
   * 未提供注入则回退到 SQLite 的 `desiredEnabled`（旧部署/测试）。
   *
   * 缺省值是 manifest 的 `defaultEnabled`，且**只有显式 `true` 才算启用**：市场安装的扩展、
   * 以及以后忘写这个字段的内置扩展都有一个安全默认——不会被自动激活。
   */
  const isDesiredEnabled = (extensionId: string): boolean => {
    if (options.toggles) {
      const explicit = options.toggles.all()[extensionId];
      if (explicit !== undefined) return explicit;
      return catalog.source.get(extensionId)?.defaultEnabled === true;
    }
    return options.store.get(extensionId)?.desiredEnabled ?? false;
  };

  const leaseFor = (extensionId: string): ExtensionWorkLease => {
    let lease = leases.get(extensionId);
    if (!lease) {
      lease = createExtensionWorkLease({
        extensionId,
        store: options.workStore,
        isDesiredEnabled: () => isDesiredEnabled(extensionId),
        committedVersion: () => options.store.get(extensionId)?.configVersion ?? null,
        isActive: () => publicVersion.has(extensionId),
        logger: options.logger
      });
      leases.set(extensionId, lease);
    }
    return lease;
  };

  const diagnosticsFor = (extensionId: string) => fallbackDiagnostics(options.store, extensionId);

  /**
   * 插件自报健康：activation 成功不等于能力可用（生成 Provider 缺凭据时仍装载）。
   *
   * 健康钩子会被每次状态查询同步调用，所以补上凭据后不用重启插件，状态就回到 active。钩子抛错
   * 不能让整份状态查询失败——按健康处理并记日志（状态宁可乐观，也不能因为诊断钩子而挂掉读模型）。
   */
  const healthFor = (extensionId: string): ApplicationBackendExtensionHealth | undefined => {
    const definition = definitionById.get(extensionId);
    if (!definition?.health) return undefined;
    try {
      return definition.health();
    } catch (error) {
      options.logger?.({
        event: "site-extension-health-failed",
        extensionId,
        message: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    }
  };

  const statusFor = (extensionId: string): ApplicationExtensionStatus | undefined => {
    const metadata = catalog.source.get(extensionId);
    if (!metadata) return undefined;
    const config = options.store.get(extensionId);
    const lease = leaseFor(extensionId);
    const actual = options.store.actual(extensionId);
    // 启停以配置文件为准；没有 SQLite 版本记录不再意味着「未配置」——配置在文件里。
    const desired = isDesiredEnabled(extensionId);
    // 只有「public 实例就是已提交版本」时插件的健康才有意义：配置中/停用时不问插件。
    const publicCurrent = desired && (options.toggles ? publicVersion.has(extensionId) : config !== undefined && publicVersion.get(extensionId) === config.configVersion);
    const health = publicCurrent ? healthFor(extensionId) : undefined;
    let actualState: ApplicationExtensionActualState;
    // 未注入 toggles 且没有 SQLite 记录：沿用「未配置」，不伪称已停用。
    if (!options.toggles && !config) {
      return {
        extensionId,
        desiredEnabled: false,
        actualState: "unconfigured" as const,
        configVersion: null,
        extensionRevision: options.store.revision(),
        activeWorkCount: lease.activeWorkCount(),
        diagnostics: diagnosticsFor(extensionId)
      };
    }
    if (suspended.has(extensionId) && desired) {
      // 安全模式暂停：只改投影，不改配置里的启停；退出安全模式后按原配置恢复。
      actualState = "suspended";
    } else if (!desired) {
      actualState = lease.isDraining() ? "draining" : "disabled";
    } else if (quarantine.has(extensionId)) {
      // 崩溃熔断：优先于 failed / configuring。
      actualState = "quarantined";
    } else if (actual?.actualState === "failed" && !publicVersion.has(extensionId)) {
      actualState = "failed";
    } else if (options.toggles ? !publicVersion.has(extensionId) : publicVersion.get(extensionId) !== config?.configVersion) {
      // 目标启用但还没有对应版本的 public 实例（首次激活中或激活失败）。
      actualState = actual?.actualState === "failed" ? "failed" : "configuring";
    } else {
      // 装载完成但能力未就绪（缺凭据等）：报 degraded，不伪称「运行中」。
      actualState = health ? "degraded" : "active";
    }
    return {
      extensionId,
      desiredEnabled: desired,
      actualState,
      configVersion: config?.configVersion ?? null,
      extensionRevision: options.store.revision(),
      activeWorkCount: lease.activeWorkCount(),
      diagnostics:
        actualState === "quarantined"
          ? [quarantine.get(extensionId)!.diagnostic]
          : health?.diagnostics && health.diagnostics.length > 0
            ? [...health.diagnostics]
            : diagnosticsFor(extensionId)
    };
  };

  const snapshot = () => {
    const metadataList = catalog.source.list();
    const plugins = metadataList
      .map((metadata) => statusFor(metadata.extensionId))
      .filter((status): status is ApplicationExtensionStatus => status !== undefined);
    const entries = metadataList.map((metadata) => ({
      extensionId: metadata.extensionId,
      name: metadata.name,
      description: metadata.description,
      ...(metadata.directory ? { directory: metadata.directory } : {}),
      version: metadata.version
    }));
    return { revision: options.store.revision(), catalog: entries, plugins };
  };

  const changes = (after: number) => {
    const current = options.store.revision();
    if (after < 0 || after > current) {
      return { revision: current, changes: [], resyncRequired: true };
    }
    // 目标与实际状态变化都记录在 status log；配置审计作为兜底。
    const changedIds = new Set<string>(options.store.changedExtensionIdsSince(after));
    for (const metadata of catalog.source.list()) {
      for (const audit of options.store.audit(metadata.extensionId, 200)) {
        if (audit.toRevision > after) changedIds.add(metadata.extensionId);
      }
    }
    const result = [...changedIds]
      .map((extensionId) => statusFor(extensionId))
      .filter((status): status is ApplicationExtensionStatus => status !== undefined)
      .map((status) => ({ revision: current, extensionId: status.extensionId, status }));
    return { revision: current, changes: result, resyncRequired: false };
  };

  /**
   * 激活某插件的指定配置版本为 public 实例。旧 public 实例（若引用清零）由调用方先释放。
   * 被工作引用的旧版本以 recovery 实例保留，不能作为公共新工作入口。
   */
  const activateExtensionVersion = async (
    extensionId: string,
    configVersion: number
  ): Promise<{ ok: true } | { ok: false; code: "activation-failed" | "activation-timeout"; message: string }> => {
    if (publicVersion.get(extensionId) === configVersion) return { ok: true };
    const definition = definitionById.get(extensionId);
    if (!definition) {
      return { ok: false, code: "activation-failed", message: `插件 ${extensionId} 没有可信后端入口` };
    }
    const timeoutMs = resolveActivationTimeout(options.activationTimeoutMs?.());
    const outcome = await awaitActivationWithDeadline(options.host.activateVersioned(definition, configVersion, "public"), timeoutMs, async () => {
      if (publicVersion.get(extensionId) === configVersion) return;
      log({ event: "site-extension-late-activation-released", extensionId, configVersion });
      await options.host.disposeVersion(extensionId, configVersion);
    });
    if (outcome.ok) publicVersion.set(extensionId, configVersion);
    return outcome;
  };

  /** 释放某插件的 public 实例（幂等）。 */
  const deactivatePublic = async (extensionId: string): Promise<void> => {
    const version = publicVersion.get(extensionId);
    if (version === undefined) return;
    await options.host.disposeVersion(extensionId, version);
    publicVersion.delete(extensionId);
  };

  /** 释放不再被任何工作引用的旧版本实例（design D6：引用清零后自动释放）。 */
  const releaseUnreferencedVersions = async (extensionId: string): Promise<void> => {
    const lease = leaseFor(extensionId);
    for (const version of options.host.activeVersions(extensionId)) {
      // 文件/manifest 启用且尚无 SQLite 配置时，当前 public 实例使用基线版本 0。
      // 它仍是公共入口，不能因为没有持久版本记录而被当作历史实例回收。
      if (version === publicVersion.get(extensionId)) continue;
      const current = options.store.get(extensionId)?.configVersion;
      if (version === current) continue;
      if (lease.activeWorkCountForVersion(version) > 0) continue;
      await options.host.disposeVersion(extensionId, version);
    }
  };

  const write: SiteExtensionControlPlane["write"] = async (input) => {
    const metadata = catalog.source.get(input.extensionId);
    if (!metadata) {
      return { ok: false, code: "extension-not-found", message: `插件 ${input.extensionId} 不在可信清单中` };
    }
    // 0) 必需基础提供者不能在线停用（任务 1.5）：其 provider 槽位由部署 profile 提供，关闭必须经
    //    发布/重启更新；返回稳定 required-provider，让 chrome/UI 引导走发布而非在线开关。
    if (!input.enabled && requiredProviderOwners.has(input.extensionId)) {
      return {
        ok: false,
        code: "required-provider",
        message: `必需基础提供者 ${input.extensionId} 不能在线停用；请通过发布/重启更新部署 profile`
      };
    }
    // 1) 校验候选（提交前；失败保留旧配置）。
    const validator = options.validateConfig;
    if (validator) {
      const error = validator(input.extensionId, input.values, metadata);
      if (error) {
        return { ok: false, code: "config-invalid", message: error };
      }
    }
    // 2) prepare：包一层 try，prepare 失败不产生提交。
    try {
      prepareCandidate(input.extensionId, input.values, input.secretRefs);
    } catch (error) {
      return { ok: false, code: "prepare-failed", message: error instanceof Error ? error.message : String(error) };
    }

    const timestamp = now().toISOString();
    // 启停写入配置文件（注入 toggles 时）：配置文件是事实来源，SQLite 只保留版本快照。
    if (options.toggles) {
      const toggled = await options.toggles.set(input.extensionId, input.enabled);
      if (!toggled.ok) {
        return { ok: false, code: "storage-failed", message: toggled.message };
      }
    }
    let committed;
    try {
      committed = options.store.commit({
        expectedRevision: input.expectedRevision,
        extensionId: input.extensionId,
        enabled: input.enabled,
        values: input.values,
        secretRefs: input.secretRefs,
        actor: input.actor,
        now: timestamp
      });
    } catch (error) {
      log({ event: "site-extension-commit-failed", extensionId: input.extensionId, message: String(error) });
      return { ok: false, code: "storage-failed", message: "站点配置写入失败" };
    }
    if (!committed.ok) {
      return {
        ok: false,
        code: "revision-conflict",
        message: "配置已被其它管理员修改",
        currentRevision: committed.currentRevision
      };
    }

    // 3) 提交后 activation：提交后失败不伪称回滚，保存 failed/degraded 实际状态。
    const held = input.enabled ? heldStateOf(input.extensionId, suspended, quarantine) : null;
    if (held) {
      // 安全模式 / 隔离期间（D7）：配置照常提交，但不激活；恢复后按已提交版本激活。
      options.store.setActual(input.extensionId, held.actualState, held.diagnostics, timestamp);
    } else if (input.enabled) {
      options.store.setActual(input.extensionId, "configuring", [], timestamp);
      // 旧版本若被在途工作引用，保留为 recovery 实例；新版本成为 public 入口。
      const newVersion = committed.config.configVersion;
      const activation = await activateExtensionVersion(input.extensionId, newVersion);
      if (activation.ok) {
        options.store.setActual(input.extensionId, "active", [], now().toISOString());
        // 被在途工作引用的旧版本恢复为 recovery 实例；引用清零的旧版本自动释放。
        await restoreReferencedVersions(input.extensionId);
        await releaseUnreferencedVersions(input.extensionId);
      } else {
        options.store.setActual(
          input.extensionId,
          "failed",
          [{ code: activation.code, message: activation.message }],
          now().toISOString()
        );
        log({ event: "site-extension-activation-failed", extensionId: input.extensionId, code: activation.code, message: activation.message });
      }
    } else {
      // 停用：不取消已有工作。有在途引用时保留资源直至引用消失（draining）；
      // 无在途引用时立即释放 public 注册并标记 disabled。
      const lease = leaseFor(input.extensionId);
      if (lease.isDraining()) {
        // 保留 public 实例供内部收尾；但公共新工作入口已按 desiredEnabled 拒绝。
        options.store.setActual(input.extensionId, "draining", [], timestamp);
      } else {
        await deactivatePublic(input.extensionId);
        await releaseUnreferencedVersions(input.extensionId);
        options.store.setActual(input.extensionId, "disabled", [], timestamp);
      }
    }
    const status = statusFor(input.extensionId);
    if (!status) {
      return { ok: false, code: "storage-failed", message: "状态投影失败" };
    }
    return { ok: true, revision: committed.revision, status };
  };

  let markRequiredReconciled!: () => void;
  const requiredReconciled = new Promise<void>((resolve) => {
    markRequiredReconciled = resolve;
  });
  const runReconcile = async (): Promise<void> => {
    // 必需提供者先协调，随后通知宿主「必需部分已就绪」；可选扩展继续在后台按顺序协调（D5）。
    const all = catalog.source.list();
    const ordered = [
      ...all.filter((metadata) => requiredProviderOwners.has(metadata.extensionId)),
      null,
      ...all.filter((metadata) => !requiredProviderOwners.has(metadata.extensionId))
    ];
    try {
      await reconcileEach(ordered);
    } finally {
      markRequiredReconciled();
    }
    log({ event: "site-extension-reconciled", revision: options.store.revision() });
  };

  const reconcileEach = async (ordered: ReadonlyArray<ApplicationExtensionMetadata | null>): Promise<void> => {
    for (const metadata of ordered) {
      if (metadata === null) {
        markRequiredReconciled();
        continue;
      }
      const config = options.store.get(metadata.extensionId);
      // 未注入 toggles 时沿用旧语义：没有 SQLite 记录就是「未配置」。
      if (!options.toggles && !config) {
        if (metadata.defaultEnabled && definitionById.has(metadata.extensionId)) {
          // 仅首次配置走正常版本化提交；手动停用后的重启不得再次启用。
          const initialized = await write({
            extensionId: metadata.extensionId, expectedRevision: options.store.revision(),
            enabled: true, values: {}, secretRefs: [], actor: "system:trusted-default"
          });
          if (!initialized.ok) log({ event: "site-extension-default-failed", extensionId: metadata.extensionId, code: initialized.code });
          continue;
        }
        // 可信清单登记但本部署未提供可信后端入口：保持 unconfigured，不伪称 failed。
        options.store.setActual(metadata.extensionId, "unconfigured", [], now().toISOString());
        continue;
      }
      if (!definitionById.has(metadata.extensionId)) {
        // 可信清单登记但本部署未提供可信后端入口：保持 unconfigured，不伪称 failed。
        options.store.setActual(metadata.extensionId, "unconfigured", [], now().toISOString());
        continue;
      }
      // 启停以配置文件为准（注入 toggles 时）；否则沿用 SQLite 的 desiredEnabled。
      const desired = isDesiredEnabled(metadata.extensionId);
      if (!desired) {
        const lease = leaseFor(metadata.extensionId);
        // 停用且无在途工作：释放 public 实例；被引用的旧版本仍保留到引用清零。
        if (!lease.isDraining()) await deactivatePublic(metadata.extensionId);
        await releaseUnreferencedVersions(metadata.extensionId);
        options.store.setActual(
          metadata.extensionId,
          lease.isDraining() ? "draining" : "disabled",
          [],
          now().toISOString()
        );
        continue;
      }
      const held = heldStateOf(metadata.extensionId, suspended, quarantine);
      if (held) {
        // 安全模式 / 崩溃熔断（D7）：不激活、不改写 desiredEnabled；隔离时释放可能残留的 public 实例。
        if (held.actualState === "quarantined") await deactivatePublic(metadata.extensionId);
        options.store.setActual(metadata.extensionId, held.actualState, held.diagnostics, now().toISOString());
        continue;
      }
      // 已启用：依据已提交版本恢复 public 实例；被引用的旧版本恢复为 recovery 实例。
      // 没有 SQLite 版本记录时（配置在文件里、从未走版本化提交）用 0 作为基线版本。
      const configVersion = config?.configVersion ?? 0;
      options.store.setActual(metadata.extensionId, "configuring", [], now().toISOString());
      await restoreReferencedVersions(metadata.extensionId);
      const activation = await activateExtensionVersion(metadata.extensionId, configVersion);
      if (activation.ok) {
        options.store.setActual(metadata.extensionId, "active", [], now().toISOString());
        await releaseUnreferencedVersions(metadata.extensionId);
      } else {
        options.store.setActual(
          metadata.extensionId,
          "failed",
          [{ code: activation.code, message: activation.message }],
          now().toISOString()
        );
        log({ event: "site-extension-activation-failed", extensionId: metadata.extensionId, code: activation.code, message: activation.message });
      }
    }
  };

  /**
   * reconcile 单飞（change: 2026-10-13-add-enterprise-access-and-production-deployment）。
   *
   * 装配期会后台触发一次 `reconcile()`（不 await），此时显式调用可能与它并发；并发执行会对同一
   * 插件版本重复 `activateVersioned`，第二次收到「已激活」并把实际状态覆盖成 failed。这里把并发
   * 调用合并到同一次执行：后到者等待同一结果，结束后允许新一次 reconcile。
   */
  let reconcileInFlight: Promise<void> | null = null;
  const reconcile: SiteExtensionControlPlane["reconcile"] = () => {
    reconcileInFlight ??= runReconcile().finally(() => {
      reconcileInFlight = null;
    });
    return reconcileInFlight;
  };

  /**
   * 重启恢复：即使 desiredEnabled 已为 false，也要为仍被工作引用的历史版本恢复 recovery 实例
   * （design D6）。凭据/配置快照由 store 提供，这里只负责实例。
   */
  const restoreReferencedVersions = async (extensionId: string): Promise<void> => {
    const definition = definitionById.get(extensionId);
    if (!definition) return;
    const lease = leaseFor(extensionId);
    for (const version of options.store.listVersions(extensionId).map((record) => record.configVersion)) {
      if (lease.activeWorkCountForVersion(version) === 0) continue;
      if (publicVersion.get(extensionId) === version) continue;
      if (options.host.activeVersions(extensionId).includes(version)) continue;
      const result = await options.host.activateVersioned(definition, version, "recovery");
      if (!result.ok) {
        log({ event: "site-extension-recovery-activation-failed", extensionId, version, message: result.message });
      }
    }
  };

  const quarantineOps = createQuarantineOperations({
    metadata: catalog.source,
    store: options.store,
    quarantine,
    now,
    log,
    statusFor,
    release: async (extensionId) => {
      await deactivatePublic(extensionId);
      await releaseUnreferencedVersions(extensionId);
    },
    reconcileOne: async (extensionId) => reconcileEach([catalog.source.get(extensionId)!])
  });
  const runtime = createRuntimeRegistration({
    catalog, definitionById, host: options.host, store: options.store, quarantine, publicVersion, statusFor, log,
    activeWorkCount: (extensionId) => leases.get(extensionId)?.activeWorkCount() ?? 0,
    disposeLease: (extensionId) => void (leases.get(extensionId)?.dispose(), leases.delete(extensionId)),
    reconcileOne: (metadata) => reconcileEach([metadata])
  });

  // 配置文件里的启停被改动（手工编辑或另一处写入）时自动重新协调；
  // 否则「目标已启用」会永远停在 configuring。
  const unsubscribeToggles = options.toggles?.subscribe?.(() => {
    void reconcile().catch((error: unknown) => {
      log({ event: "site-extension-toggle-reconcile-failed", message: error instanceof Error ? error.message : String(error) });
    });
  });

  return {
    snapshot,
    changes,
    status: statusFor,
    write,
    reconcile,
    requiredReconciled: () => requiredReconciled,
    addExtension: runtime.addExtension,
    removeExtension: runtime.removeExtension,
    quarantine: quarantineOps.quarantine,
    unquarantine: quarantineOps.unquarantine,
    workLease: (extensionId) => (catalog.source.get(extensionId) ? leaseFor(extensionId) : undefined),
    configFacade: (extensionId) => ({
      configVersion: () => options.store.get(extensionId)?.configVersion ?? null,
      // 配置值来自配置文件（`extensions.<id>.*`）；未提供 toggles 的旧部署仍读 SQLite。
      values: () => (options.toggles ? (options.toggles.values?.(extensionId) ?? {}) : (options.store.get(extensionId)?.values ?? {})),
      secretRefs: () => options.store.get(extensionId)?.secretRefs ?? [],
      desiredEnabled: () => options.store.get(extensionId)?.desiredEnabled ?? false
    }),
    workFacade: (extensionId) => {
      const lease = leaseFor(extensionId);
      return {
        admit: () => {
          const result = lease.admit();
          return result.ok
            ? { ok: true, workId: result.workId, configVersion: result.configVersion }
            : { ok: false, reason: result.reason };
        },
        resume: (workId) => {
          const handle = lease.resume(workId);
          return handle
            ? {
                workId: handle.workId,
                configVersion: handle.configVersion,
                markRunning: () => handle.markRunning(),
                settle: (state) => handle.settle(state)
              }
            : null;
        },
        activeWorkCount: () => lease.activeWorkCount()
      };
    },
    dispose: async () => {
      unsubscribeToggles?.();
      for (const lease of leases.values()) lease.dispose();
      leases.clear();
      publicVersion.clear();
    }
  };
}
