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
import {
  safeDiagnosticDetail,
  type ApplicationBackendExtensionHealth,
  type ApplicationExtensionActualState,
  type ApplicationExtensionMetadata,
  type ApplicationExtensionSafeDiagnostic,
  type ApplicationExtensionStatus,
  type RequiredProviderProfiles
} from "@woohaa3/contracts";
import type { ApplicationBackendExtensionDefinition, ApplicationBackendConfigFacade, ApplicationBackendWorkFacade } from "./contract.js";
import type { ApplicationExtensionHost } from "./host.js";
import type { SqliteSiteExtensionConfigStore } from "./config-store.js";
import { createExtensionWorkLease, type ExtensionWorkLease, type ExtensionWorkReferenceStore } from "./work.js";

export type SiteExtensionControlPlaneError =
  | { ok: false; code: "extension-not-found"; message: string }
  | { ok: false; code: "config-invalid"; message: string }
  | { ok: false; code: "prepare-failed"; message: string }
  | { ok: false; code: "required-provider"; message: string }
  | { ok: false; code: "revision-conflict"; message: string; currentRevision: number }
  | { ok: false; code: "storage-failed"; message: string };

export type SiteExtensionWriteOutcome =
  | { ok: true; revision: number; status: ApplicationExtensionStatus }
  | SiteExtensionControlPlaneError;

export type SiteExtensionMetadataSource = {
  list: () => readonly ApplicationExtensionMetadata[];
  get: (extensionId: string) => ApplicationExtensionMetadata | undefined;
};

export type SiteExtensionControlPlaneOptions = {
  host: ApplicationExtensionHost;
  store: SqliteSiteExtensionConfigStore;
  workStore: ExtensionWorkReferenceStore;
  metadata: SiteExtensionMetadataSource;
  /** 构建时可信后端入口（按 extensionId 静态登记；生产/测试清单不同）。 */
  definitions: readonly ApplicationBackendExtensionDefinition[];
  /**
   * 可信部署 profile 里必需基础提供者（按 extensionId）。用于拒绝在线停用必需 provider
   * （change: 2026-10-13-...，任务 1.5）：必需提供者只能经发布/重启更新，不能由站点控制面关闭。
   */
  requiredProviders?: RequiredProviderProfiles;
  /**
   * 候选配置校验：返回 null 表示通过，否则为安全错误信息。
   * 由插件 config schema owner 提供；缺省接受任意已校验 JSON。
   */
  validateConfig?: (extensionId: string, values: Record<string, unknown>, metadata: ApplicationExtensionMetadata) => string | null;
  now?: () => Date;
  logger?: (event: Record<string, unknown>) => void;
};

export type SiteExtensionControlPlane = {
  /** 公开 snapshot：全部已配置插件 + 实际状态（不含秘密）。 */
  snapshot: () => { revision: number; catalog: Array<{ extensionId: string; name: string; description: string; version: string; directory?: string }>; plugins: ApplicationExtensionStatus[] };
  /** 有界增量：cursor 过旧时 resyncRequired。 */
  changes: (after: number) => { revision: number; changes: Array<{ revision: number; extensionId: string; status: ApplicationExtensionStatus }>; resyncRequired: boolean };
  /** 单插件状态（含未配置插件）。 */
  status: (extensionId: string) => ApplicationExtensionStatus | undefined;
  /** 带 expectedRevision 的管理写入。 */
  write: (input: { extensionId: string; expectedRevision: number; enabled: boolean; values: Record<string, unknown>; secretRefs: string[]; actor: string }) => Promise<SiteExtensionWriteOutcome>;
  /** 进程启动/重启后依据已提交版本重建实际状态（commit 后崩溃的恢复路径）。 */
  reconcile: () => Promise<void>;
  /** 在途工作 lease（供插件 facade / 内部工作接线）。 */
  workLease: (extensionId: string) => ExtensionWorkLease | undefined;
  /** 宿主注入的配置 facade（只读已提交配置；不含秘密值）。 */
  configFacade: (extensionId: string) => ApplicationBackendConfigFacade;
  /** 宿主注入的在途工作 facade（admit/resume/计数）。 */
  workFacade: (extensionId: string) => ApplicationBackendWorkFacade;
  dispose: () => Promise<void>;
};

const ACTUAL_TO_DIAGNOSTIC: Partial<Record<ApplicationExtensionActualState, string>> = {
  failed: "插件激活失败",
  degraded: "插件处于降级状态",
  unconfigured: "插件尚未配置"
};

export function createSiteExtensionControlPlane(options: SiteExtensionControlPlaneOptions): SiteExtensionControlPlane {
  const now = options.now ?? (() => new Date());
  const log = options.logger ?? (() => undefined);
  const definitionById = new Map(options.definitions.map((definition) => [definition.extensionId, definition]));
  // 必需基础提供者的 owner extension（任务 1.5）：在线停用一律拒绝，必须经发布/重启更新 profile。
  const requiredProviderOwners = new Set((options.requiredProviders ?? []).map((profile) => profile.extensionId));
  const leases = new Map<string, ExtensionWorkLease>();
  /** extensionId -> 当前 public 实例的配置版本（undefined 表示未激活公共实例）。 */
  const publicVersion = new Map<string, number>();

  const leaseFor = (extensionId: string): ExtensionWorkLease => {
    let lease = leases.get(extensionId);
    if (!lease) {
      lease = createExtensionWorkLease({
        extensionId,
        store: options.workStore,
        isDesiredEnabled: () => options.store.get(extensionId)?.desiredEnabled ?? false,
        committedVersion: () => options.store.get(extensionId)?.configVersion ?? null,
        isActive: () => publicVersion.has(extensionId),
        logger: options.logger
      });
      leases.set(extensionId, lease);
    }
    return lease;
  };

  const diagnosticsFor = (extensionId: string): ApplicationExtensionSafeDiagnostic[] => {
    const actual = options.store.actual(extensionId);
    if (actual && actual.diagnostics.length > 0) return actual.diagnostics;
    const state = actual?.actualState;
    if (state && ACTUAL_TO_DIAGNOSTIC[state]) {
      return [{ code: state, message: ACTUAL_TO_DIAGNOSTIC[state] as string }];
    }
    if (!options.store.get(extensionId)) {
      return [{ code: "unconfigured", message: "插件尚未配置" }];
    }
    return [];
  };

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
    const metadata = options.metadata.get(extensionId);
    if (!metadata) return undefined;
    const config = options.store.get(extensionId);
    const lease = leaseFor(extensionId);
    const actual = options.store.actual(extensionId);
    // 只有「public 实例就是已提交版本」时插件的健康才有意义：配置中/停用时不问插件。
    const publicCurrent =
      config !== undefined && config.desiredEnabled && publicVersion.get(extensionId) === config.configVersion;
    const health = publicCurrent ? healthFor(extensionId) : undefined;
    let actualState: ApplicationExtensionActualState;
    if (!config) {
      actualState = "unconfigured";
    } else if (actual?.actualState === "failed" && !publicVersion.has(extensionId) && config.desiredEnabled) {
      actualState = "failed";
    } else if (!config.desiredEnabled) {
      actualState = lease.isDraining() ? "draining" : "disabled";
    } else if (publicVersion.get(extensionId) !== config.configVersion) {
      actualState = "configuring";
    } else {
      // 装载完成但能力未就绪（缺凭据等）：报 degraded，不伪称「运行中」。
      actualState = health ? "degraded" : "active";
    }
    return {
      extensionId,
      desiredEnabled: config?.desiredEnabled ?? false,
      actualState,
      configVersion: config?.configVersion ?? null,
      extensionRevision: options.store.revision(),
      activeWorkCount: lease.activeWorkCount(),
      diagnostics: health?.diagnostics && health.diagnostics.length > 0 ? [...health.diagnostics] : diagnosticsFor(extensionId)
    };
  };

  const snapshot = () => {
    const metadataList = options.metadata.list();
    const plugins = metadataList
      .map((metadata) => statusFor(metadata.extensionId))
      .filter((status): status is ApplicationExtensionStatus => status !== undefined);
    const catalog = metadataList.map((metadata) => ({
      extensionId: metadata.extensionId,
      name: metadata.name,
      description: metadata.description,
      ...(metadata.directory ? { directory: metadata.directory } : {}),
      version: metadata.version
    }));
    return { revision: options.store.revision(), catalog, plugins };
  };

  const changes = (after: number) => {
    const current = options.store.revision();
    if (after < 0 || after > current) {
      return { revision: current, changes: [], resyncRequired: true };
    }
    // 目标与实际状态变化都记录在 status log；配置审计作为兜底。
    const changedIds = new Set<string>(options.store.changedExtensionIdsSince(after));
    for (const metadata of options.metadata.list()) {
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
  ): Promise<{ ok: true } | { ok: false; message: string }> => {
    if (publicVersion.get(extensionId) === configVersion) return { ok: true };
    const definition = definitionById.get(extensionId);
    if (!definition) {
      return { ok: false, message: `插件 ${extensionId} 没有可信后端入口` };
    }
    try {
      const result = await options.host.activateVersioned(definition, configVersion, "public");
      if (!result.ok) {
        return { ok: false, message: result.message };
      }
      publicVersion.set(extensionId, configVersion);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
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
      const current = options.store.get(extensionId)?.configVersion;
      if (version === current) continue;
      if (lease.activeWorkCountForVersion(version) > 0) continue;
      await options.host.disposeVersion(extensionId, version);
    }
  };

  const write: SiteExtensionControlPlane["write"] = async (input) => {
    const metadata = options.metadata.get(input.extensionId);
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
    if (input.enabled) {
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
          [{ code: "activation-failed", message: activation.message }],
          now().toISOString()
        );
        log({ event: "site-extension-activation-failed", extensionId: input.extensionId, message: activation.message });
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

  const runReconcile = async (): Promise<void> => {
    for (const metadata of options.metadata.list()) {
      const config = options.store.get(metadata.extensionId);
      if (!config) {
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
      if (!config.desiredEnabled) {
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
      // 已启用：依据已提交版本恢复 public 实例；被引用的旧版本恢复为 recovery 实例。
      options.store.setActual(metadata.extensionId, "configuring", [], now().toISOString());
      await restoreReferencedVersions(metadata.extensionId);
      const activation = await activateExtensionVersion(metadata.extensionId, config.configVersion);
      if (activation.ok) {
        options.store.setActual(metadata.extensionId, "active", [], now().toISOString());
        await releaseUnreferencedVersions(metadata.extensionId);
      } else {
        options.store.setActual(
          metadata.extensionId,
          "failed",
          [{ code: "activation-failed", message: activation.message }],
          now().toISOString()
        );
      }
    }
    log({ event: "site-extension-reconciled", revision: options.store.revision() });
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

  return {
    snapshot,
    changes,
    status: statusFor,
    write,
    reconcile,
    workLease: (extensionId) => (options.metadata.get(extensionId) ? leaseFor(extensionId) : undefined),
    configFacade: (extensionId) => ({
      configVersion: () => options.store.get(extensionId)?.configVersion ?? null,
      values: () => options.store.get(extensionId)?.values ?? {},
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
      for (const lease of leases.values()) lease.dispose();
      leases.clear();
      publicVersion.clear();
    }
  };
}

/**
 * prepare 候选配置：只接受已校验的非秘密值与 opaque secret reference，且不允许 URL/data 载体。
 * 真正的资源准备（如打开连接）由插件 activation 完成；这里保证候选本身可安全提交。
 */
function prepareCandidate(extensionId: string, values: Record<string, unknown>, secretRefs: readonly string[]): void {
  void extensionId;
  for (const ref of secretRefs) {
    const lower = ref.toLowerCase();
    if (lower.includes("://") || lower.startsWith("data:") || lower.startsWith("blob:")) {
      throw new Error("secret reference 不得是 URL/data/blob 载体");
    }
  }
  const serialized = JSON.stringify(values);
  if (serialized !== undefined && serialized.length > 64 * 1024) {
    throw new Error("候选配置超出大小上限");
  }
  void safeDiagnosticDetail;
}
