/**
 * 核心层 · extensionManager：受管扩展的安装、卸载、回滚与观察期
 * （change: 2026-10-21-add-extension-marketplace-point，D6–D10）。
 *
 * - 受管根取自扩展宿主扫描结果（`extensionHost.managedRoot`，与扫描器同一个值）；没有受管根时不装配。
 * - 信任根 = 内置官方公钥（`official-trust.ts`，dev / release / 桌面同一份代码）+ 本机配置
 *   （`extensions.marketplace.trustedKeys`，只能追加）；未签名开关也来自本机配置，按调用现取，不经站点配置面写入。
 * - 本地文件来源（`local-file`）在这里注册进 `ctx.marketplace`（核心自带，非扩展）。
 * - GitHub Release 来源（`github-release`）同样核心自带：D3「来源插件只能来自内置根」防的是
 *   「市场装市场」的信任提升，核心自带来源随宿主发布、没有这个问题。
 * - 受管根被另一个进程锁住时 Manager 不可写（`MARKETPLACE_WRITER_LOCKED` 记日志），宿主照常启动。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { ExtensionDocumentStore } from "@woohaa3/contracts";
import type { LoadedExtensionHost } from "../../../extensions/manifest.js";
import { createExtensionInstallApiHandler } from "../../../api/extension-install-api.js";
import type { HostPlugin } from "../../context.js";
import { ROUTE_ORDER } from "../../order.js";
import { createExtensionManager, type ExtensionManager, type ObservedHealth } from "./manager.js";
import { beginSwap, endSwap } from "./swap-registry.js";
import { createReloadingHandler } from "./swap-reloading-route.js";
import { loadPackageToolkit } from "./toolkit.js";
import { createVersionStatusCache, managedVersionStatus, marketplaceExtensionDetail } from "./marketplace-detail.js";
import { createGithubReleaseSource, DEFAULT_GITHUB_API_BASE, GITHUB_RELEASE_SOURCE_ID, parseRepoList } from "./github-source.js";
import { OFFICIAL_MARKETPLACE_TRUSTED_KEYS } from "./official-trust.js";
import type { ExtensionRuntimePort } from "./manager-types.js";
import type { ExtensionPackageToolkit, InstallationsHandle, TrustedKey } from "./types.js";

export type { ExtensionManager } from "./manager.js";

export type ExtensionManagerPluginConfig = {
  env: Record<string, string | undefined>;
  extensionHost?: LoadedExtensionHost;
  /** 测试注入。 */
  toolkit?: ExtensionPackageToolkit;
  observeIntervalMs?: number;
};

const OBSERVE_INTERVAL_MS = 30_000;

/** 合并信任根：内置官方公钥 + 本机配置，按 keyId 去重（内置优先，不能被同 keyId 的配置替换）。 */
export function mergeTrustedKeys(...groups: ReadonlyArray<readonly TrustedKey[]>): TrustedKey[] {
  const merged: TrustedKey[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const key of group) {
      const identity = key.keyId ? `id:${key.keyId}` : `key:${key.publicKey}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      merged.push(key);
    }
  }
  return merged;
}

/** `extensions.marketplace.trustedKeys`：逗号分隔的 `<keyId>=<base64 公钥>` 或单个 base64 公钥。 */
export function parseTrustedKeys(raw: unknown): TrustedKey[] {
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const index = entry.indexOf("=");
      // base64 公钥自身可能以 = 结尾：只有 keyId 段是合法 kebab/hex 时才拆分。
      if (index > 0 && /^[A-Za-z0-9_-]+$/.test(entry.slice(0, index)) && entry.length > index + 1) {
        return { keyId: entry.slice(0, index), publicKey: entry.slice(index + 1) };
      }
      return { keyId: undefined as unknown as string, publicKey: entry };
    })
    .map((key) => (key.keyId ? key : { publicKey: key.publicKey } as TrustedKey));
}

/** 分页扫描整个 owner 空间并逐批删除；每批是一个原子 batch，中途失败可重复执行（幂等）。 */
export async function purgeExtensionDocuments(store: Pick<ExtensionDocumentStore, "scan" | "batch">): Promise<number> {
  let removed = 0;
  for (;;) {
    // 删除后从头再扫：游标基于 key，已删的不会再出现，避免依赖删除前的游标。
    const page = await store.scan("", { limit: 500 });
    if (page.entries.length === 0) return removed;
    const result = await store.batch(page.entries.map((entry) => ({ op: "delete" as const, key: entry.key })));
    if (!result.ok) throw new Error(`清除扩展数据失败：${result.code}`);
    removed += page.entries.length;
  }
}

export const extensionManagerPlugin: HostPlugin<ExtensionManagerPluginConfig> = {
  name: "extensionManager",
  inject: ["log", "gateway", "access", "config", "marketplace"],
  async apply(ctx, config) {
    const log = ctx.log.scope("extension-manager");
    const host = config.extensionHost;
    const managedRoot = host?.managedRoot;
    if (!managedRoot) {
      log({ event: "extension-manager-disabled", reason: "no-managed-root" });
      return;
    }
    const toolkit = config.toolkit ?? (await loadPackageToolkit(config.env));
    if (!toolkit) {
      log({ event: "extension-manager-disabled", reason: "toolkit-missing" });
      return;
    }
    let handle: InstallationsHandle | null = null;
    try {
      handle = toolkit.openInstallations({ managedRoot, lock: true });
    } catch (error) {
      log({ event: "extension-manager-unavailable", code: (error as { code?: string })?.code ?? null, message: error instanceof Error ? error.message : String(error) });
    }

    const settings = ctx.config;
    // 官方公钥随客户端发布内置（dev / Web release / 桌面宿主同一份后端代码）；
    // 本机配置只能追加信任根，不能移除内置 key。
    const trustedKeys = () =>
      mergeTrustedKeys(
        OFFICIAL_MARKETPLACE_TRUSTED_KEYS,
        parseTrustedKeys(settings.get("extensions.marketplace.trustedKeys" as never))
      );
    const application = () => ctx.get("application");
    const siteStatus = (extensionId: string) => application()?.service.plugins().status(extensionId);
    // 内置根的版本/目录来自启动期扫描；即使当前被更高的受管版本覆盖也保留（卸载回退、版本比较要用）。
    const builtins = new Map(
      (host.builtinExtensions ?? []).map((entry) => [entry.extensionId, entry] as const)
    );

    // GitHub Release 来源（核心自带第二个来源，与 local-file 同级）：配置按调用现取（热重载即刻生效）。
    // enabled / repos 都带缺省值（官方市场仓库），开箱即可搜索安装；关掉后 available() 不可用且绝不发请求。
    // 没有令牌时走网页端点（不吃 REST API 限额），有令牌或自建实例才走 API；判定在来源内部。
    // 令牌优先取密钥文件里的 extensions.marketplace.github.token，环境变量 WOOHAA3_GITHUB_TOKEN 兜底。
    const githubSource = createGithubReleaseSource({
      config: () => ({
        enabled: settings.get("extensions.marketplace.github.enabled" as never) === true,
        repos: parseRepoList(settings.get("extensions.marketplace.github.repos" as never)),
        apiBase:
          (settings.get("extensions.marketplace.github.apiBase" as never) as string | undefined) ?? DEFAULT_GITHUB_API_BASE,
        token: (settings.get("extensions.marketplace.github.token" as never) as string | undefined) ?? config.env.WOOHAA3_GITHUB_TOKEN ?? ""
      })
    });
    const unregisterGithub = ctx.marketplace.resolve(GITHUB_RELEASE_SOURCE_ID)
      ? () => undefined
      : ctx.marketplace.register(githubSource);
    /**
     * 进程内热切换（C 方向）：先撤下旧 fiber（Cordis effect 回滚它注册的 Provider / 路由 / 监听），
     * 再 import 新版本目录并 add 新插件。同名插件不能并存，因此这段时间该扩展缺席；
     * 失败时尽力装回 `previousDirectory`，由 Manager 按换版失败处理。
     */
    const runtimeSwap = (): ExtensionRuntimePort | undefined => {
      // 注意：扩展层是核心层装载后才 `ctx.provide` 的，因此这里**不能**在构造期判断它是否存在，
      // 否则永远拿到 undefined。能力判定一律推到调用期（`available()`）。
      if (!toolkit.loadRuntimePlugin) return undefined;
      const layer = () => ctx.get("extensionLayer");
      const versionOf = (directory: string) => path.basename(directory);
      /**
       * 站点扩展的元数据：优先用**这次要装载的目录**里的声明，只有启动期那一行指向同一目录时才复用它。
       *
       * 受管扩展装过一次并被重启扫到后，`host.metadata` 里那一行的 version / directory 指向旧版本目录；
       * 换版若沿用它会得到「新代码 + 旧元数据」，前端版本号与控制面目录都停在旧值。
       *
       * `origin` 同样要跟着目录重算：它决定这一行能不能被卸载。目录落在受管根下就是 `managed`——
       * 即便它出现在启动期扫描清单里，也不是内置扩展。
       */
      const originOfDirectory = (extensionId: string, directory: string) => {
        const installedRoot = path.join(managedRoot, "installed") + path.sep;
        if (path.resolve(directory).startsWith(installedRoot)) return "managed" as const;
        const found = host.metadata?.find((entry) => entry.extensionId === extensionId);
        return found?.origin ?? "builtin";
      };
      const siteMetadataOf = (extensionId: string, directory: string, descriptor: unknown) => {
        const found = host.metadata?.find((entry) => entry.extensionId === extensionId);
        const site = (descriptor as { site?: Record<string, unknown> } | null)?.site;
        if (!site) return found ?? null;
        return {
          ...(found ?? {}),
          extensionId,
          directory,
          name: typeof site.name === "string" ? site.name : found?.name ?? extensionId,
          description: typeof site.description === "string" ? site.description : found?.description ?? "",
          version: typeof site.version === "string" ? site.version : versionOf(directory),
          managementScope: "site",
          host: "backend",
          configSchema: site.configSchema,
          dependencies: Array.isArray(site.dependencies) ? site.dependencies : [],
          capabilities: Array.isArray(site.capabilities) ? site.capabilities : [],
          ...(site.defaultEnabled === undefined ? {} : { defaultEnabled: site.defaultEnabled }),
          frontendEntry: existsSync(path.join(directory, "browser-dist", "artifact-manifest.json")),
          backendHosts: ["backend"],
          configScope: "site",
          origin: originOfDirectory(extensionId, directory)
        } as never;
      };
      /**
       * 装配一个版本。
       *
       * `replace` = 控制面目录里已有这个 id（受管扩展装过、重启后被扫描进启动期清单，或换版/回滚）。
       * 那种情况走 `replaceExtension` 覆盖同一行，而不是 add。
       */
      const mount = async (extensionId: string, directory: string, version?: string, options: { replace?: boolean } = {}) => {
        // `version` 同时是模块身份：开发者模式的产物始终在同一目录，靠它制造新的模块 URL（D6）。
        const loaded = await toolkit.loadRuntimePlugin!({ dir: directory, extensionId, version: version ?? versionOf(directory) });
        const plane = application()?.service.plugins();
        const gate = application()?.siteGate;
        const metadata = siteMetadataOf(extensionId, directory, loaded.descriptor);
        let definition = null as ReturnType<NonNullable<typeof gate>["add"]> | null;
        if (metadata && plane && gate) {
          definition = gate.add(extensionId);
        }
        const entry = layer()!.add(loaded.plugin);
        if (!entry) {
          if (definition && gate) gate.remove(extensionId);
          throw Object.assign(new Error(`扩展 ${extensionId} 的配置段无效，无法热切换`), { code: "extension-config-invalid" });
        }
        await entry.started;
        if (definition && plane) {
          const outcome = options.replace
            ? await plane.replaceExtension({ metadata: metadata as never, definition })
            : await plane.addExtension({ metadata: metadata as never, definition });
          if (!outcome.ok) {
            await layer()!.remove(extensionId);
            gate?.remove(extensionId);
            throw Object.assign(new Error(outcome.message), { code: outcome.code });
          }
        }
      };
      return {
        available: () => Boolean(layer()),
        async swap(extensionId, directory, version, previousDirectory, previousVersion) {
          const target = layer();
          if (!target) throw Object.assign(new Error("宿主不支持运行期装配"), { code: "extension-host-unsupported" });
          const plane = application()?.service.plugins();
          const gate = application()?.siteGate;
          // 控制面目录里已有这个 id 时，新版本要**覆盖同一行**（replaceExtension），不能先摘再加：
          // 摘除对启动期清单的行是拒绝的，受管扩展装过并重启后它就在启动期清单里。
          const listed = plane?.snapshot().catalog.some((entry) => entry.extensionId === extensionId) ?? false;
          // 门禁的那一条要重建：装载闭包（fiber / 注册面）换新了，旧 handle 只会重启动旧插件。
          // 它只影响「谁来 acquire」，不动控制面那一行。
          gate?.remove(extensionId);
          // 换版窗口：从撤旧到装配完成之间，该扩展的路由 / Provider 都不存在。
          // 网关据此返回可重试的 extension-reloading，而不是让调用方看到 404。
          beginSwap(extensionId);
          try {
            // 先撤旧：同名插件不能并存。
            await target.remove(extensionId);
            try {
              await mount(extensionId, directory, version, { replace: listed });
              return { swapped: true };
            } catch (error) {
              if (previousDirectory) {
                try {
                  // 装回时必须带旧 token：同目录不同 token 才是不同模块实例。
                  await mount(extensionId, previousDirectory, previousVersion ?? undefined, { replace: listed });
                } catch (restoreError) {
                  log({ event: "extension-swap-restore-failed", extensionId, message: restoreError instanceof Error ? restoreError.message : String(restoreError) });
                }
              }
              throw error;
            }
          } finally {
            endSwap(extensionId);
          }
        },
        async remove(extensionId) {
          const plane = application()?.service.plugins();
          const gate = application()?.siteGate;
          const listed = plane?.snapshot().catalog.some((entry) => entry.extensionId === extensionId) ?? false;
          if (listed && plane) {
            const removed = await plane.removeExtension(extensionId);
            if (!removed.ok && removed.code !== "extension-not-found") {
              throw Object.assign(new Error(removed.message ?? "站点扩展无法卸载"), { code: removed.code });
            }
          }
          await layer()?.remove(extensionId);
          gate?.remove(extensionId);
        }
      };
    };
    const manager: ExtensionManager = createExtensionManager(
      {
        managedRoot,
        toolkit,
        ...(runtimeSwap() ? { runtime: runtimeSwap()! } : {}),
        marketplace: ctx.marketplace,
        trust: () => ({ trustedKeys: trustedKeys() }),
        builtins: () => builtins,
        installedVersions: () => {
          const versions = new Map<string, string>();
          for (const entry of builtins.values()) {
            if (entry.version) versions.set(entry.extensionId, entry.version);
          }
          // 兼容旧宿主：内置扫描结果里没有的站点扩展，仍按 metadata 的 site.version 参与依赖检查。
          for (const entry of host.metadata ?? []) {
            const version = (entry as { site?: { version?: string } }).site?.version;
            if (!versions.has(entry.extensionId) && typeof version === "string") versions.set(entry.extensionId, version);
          }
          for (const entry of manager.installed()) versions.set(entry.extensionId, entry.version);
          return versions;
        },
        ...(host.publishBrowserRelease ? { publishBrowserRelease: host.publishBrowserRelease } : {}),
        ...(ctx.get("hostRestart") ? { restart: ctx.get("hostRestart")! } : {}),
        // 卸载时「同时清除数据」：删除该扩展 owner 下的全部 documents（storage 槽位的通用文档存储）。
        // 没有文档存储（或该扩展未登记 owner）时什么都不做；密钥文件与媒体不在这里清理。
        purgeData: async (extensionId) => {
          const store = ctx.access.foundationStorage?.documents.forExtension(extensionId);
          if (store) await purgeExtensionDocuments(store);
        },
        disableSite: async (extensionId, actor) => {
          const plane = application()?.service.plugins();
          const status = plane?.status(extensionId);
          if (!plane || !status) return "unmanaged";
          if (!status.desiredEnabled) return status.actualState === "draining" ? "draining" : "disabled";
          const facade = plane.configFacade(extensionId);
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const outcome = await plane.write({
              extensionId,
              expectedRevision: plane.snapshot().revision,
              enabled: false,
              values: facade.values(),
              secretRefs: [...facade.secretRefs()],
              actor
            });
            if (outcome.ok) return outcome.status.actualState === "draining" ? "draining" : "disabled";
            if ((outcome as { code?: string }).code !== "revision-conflict") break;
          }
          const latest = plane.status(extensionId);
          return latest && !latest.desiredEnabled ? (latest.actualState === "draining" ? "draining" : "disabled") : "unmanaged";
        },
        siteState: (extensionId) => {
          const status = siteStatus(extensionId);
          if (!status) return "unmanaged";
          if (status.actualState === "draining") return "draining";
          if (status.actualState === "disabled") return "disabled";
          if (status.actualState === "active") return "active";
          return "other";
        },
        health: (extensionId): ObservedHealth => {
          const status = siteStatus(extensionId);
          if (!status || !status.desiredEnabled) return "unknown";
          if (status.actualState === "failed") return "failed";
          if (status.actualState === "degraded") return "degraded";
          if (status.actualState === "active") return "ok";
          return "unknown";
        },
        logger: log
      },
      handle
    );
    ctx.provide("extensionManager", manager);
    ctx.effect(() => () => manager.close());

    // 开发者模式热重载（change: 2026-10-27-add-extension-dev-reload，D2/D6/D7）：
    // 编排在脚本层（那里本来就懂开发者目录），这里只暴露「用新 token 重装后端」这一个窄端口，
    // 由宿主启动时接上。没有该端口（最小装配）时只走前端面。
    const port = runtimeSwap();
    // 把「用新 token 重装后端」注册给宿主：开发者模式的编排在脚本层，只有这里知道运行时端口。
    // `previousToken` 为空表示没有可装回的版本，失败即失败（D6 的 last-good）。
    const unregisterDevSwap = host.registerDevSwapPort?.({
      async swapDev(extensionId: string, directory: string, token: string, previousToken: string | null): Promise<void> {
        if (!port?.available()) throw new Error("宿主不支持运行期装配，无法热切换后端产物");
        await port.swap(extensionId, directory, token, previousToken ? directory : null, previousToken ?? null);
      }
    });
    if (unregisterDevSwap) ctx.effect(() => unregisterDevSwap);
    ctx.effect(() => unregisterGithub);

    const interval = config.observeIntervalMs ?? OBSERVE_INTERVAL_MS;
    const timer = setInterval(() => {
      void manager.observe().catch((error) => log({ event: "extension-observe-failed", message: error instanceof Error ? error.message : String(error) }));
    }, interval);
    timer.unref?.();
    ctx.effect(() => () => clearInterval(timer));
    try {
      manager.sweep();
    } catch (error) {
      log({ event: "extension-version-sweep-failed", message: error instanceof Error ? error.message : String(error) });
    }

    // 市场版本详情（change: 2026-10-21-add-server-extension-marketplace，tasks 7.4）。
    const detailDeps = {
      marketplace: ctx.marketplace,
      trustedKeys: () => trustedKeys(),
      keyIdOf: (publicKey: string) => {
        try {
          return toolkit.keyIdOf ? toolkit.keyIdOf(publicKey) : null;
        } catch {
          return null;
        }
      },
      installedVersion: (extensionId: string) =>
        manager.installed().find((entry) => entry.extensionId === extensionId)?.version ?? builtins.get(extensionId)?.version,
      installedKind: (extensionId: string) =>
        manager.installed().some((entry) => entry.extensionId === extensionId)
          ? ("managed" as const)
          : builtins.has(extensionId)
            ? ("builtin" as const)
            : undefined
    };
    // 已撤回提示：按需查询 + 5 分钟缓存（不轮询）。
    const versionStatus = createVersionStatusCache((input) => managedVersionStatus(detailDeps, input, AbortSignal.timeout(10_000)));
    const handler = createExtensionInstallApiHandler({
      manager: () => manager,
      marketplaceDetail: () => (input, signal) => marketplaceExtensionDetail(detailDeps, input, signal),
      versionStatus: () => versionStatus,
      authenticator: ctx.access.authenticator,
      accessEnforcer: ctx.access.accessEnforcer,
      logger: log
    });
    ctx.effect(() => ctx.gateway.route(ROUTE_ORDER.extensionInstall, handler));

    // 换版窗口拦截：进程内热切换是「先卸后装」，这段时间该扩展的路由不存在。直接落到下游会变成
    // 404（被读成「扩展不存在」这一永久失败），所以这里先答「正在换版，稍后重试」。
    ctx.effect(() => ctx.gateway.route(ROUTE_ORDER.extensionReloading, createReloadingHandler()));
  }
};