/**
 * 核心层 · extensionManager：受管扩展的安装、卸载、回滚与观察期
 * （change: 2026-10-21-add-extension-marketplace-point，D6–D10）。
 *
 * - 受管根取自扩展宿主扫描结果（`extensionHost.managedRoot`，与扫描器同一个值）；没有受管根时不装配。
 * - 信任根与未签名开关来自本机配置（`extensions.marketplace.*`），按调用现取，不经站点配置面写入。
 * - 本地文件来源（`local-file`）在这里注册进 `ctx.marketplace`（核心自带，非扩展）。
 * - GitHub Release 来源（`github-release`）同样核心自带：D3「来源插件只能来自内置根」防的是
 *   「市场装市场」的信任提升，核心自带来源随宿主发布、没有这个问题。
 * - 受管根被另一个进程锁住时 Manager 不可写（`MARKETPLACE_WRITER_LOCKED` 记日志），宿主照常启动。
 */
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
import { createGithubReleaseSource, GITHUB_RELEASE_SOURCE_ID, parseRepoList } from "./github-source.js";
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
    const envAllow = config.env.WOOHAA3_EXTENSION_ALLOW_UNSIGNED === "1";
    const application = () => ctx.get("application");
    const siteStatus = (extensionId: string) => application()?.service.plugins().status(extensionId);
    const builtinIds = new Set((host.metadata ?? []).map((entry) => entry.extensionId));

    // GitHub Release 来源（核心自带第二个来源，与 local-file 同级）：配置按调用现取（热重载即刻生效）；
    // enabled 缺省 false——出网行为必须显式开启，未开启时 available() 不可用且绝不发请求。
    // 令牌优先取密钥文件里的 extensions.marketplace.github.token，环境变量 WOOHAA3_GITHUB_TOKEN 兜底。
    const githubSource = createGithubReleaseSource({
      config: () => ({
        enabled: settings.get("extensions.marketplace.github.enabled" as never) === true,
        repos: parseRepoList(settings.get("extensions.marketplace.github.repos" as never)),
        apiBase: (settings.get("extensions.marketplace.github.apiBase" as never) as string | undefined) ?? "https://api.github.com",
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
      const mount = async (extensionId: string, directory: string) => {
        const loaded = await toolkit.loadRuntimePlugin!({ dir: directory, extensionId, version: versionOf(directory) });
        const plane = application()?.service.plugins();
        const gate = application()?.siteGate;
        const metadata = host.metadata?.find((entry) => entry.extensionId === extensionId) ?? null;
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
          const outcome = await plane.addExtension({ metadata: metadata as never, definition });
          if (!outcome.ok) {
            await layer()!.remove(extensionId);
            gate?.remove(extensionId);
            throw Object.assign(new Error(outcome.message), { code: outcome.code });
          }
        }
      };
      return {
        available: () => Boolean(layer()),
        async swap(extensionId, directory, _version, previousDirectory) {
          const target = layer();
          if (!target) throw Object.assign(new Error("宿主不支持运行期装配"), { code: "extension-host-unsupported" });
          // 换版窗口：从撤旧到装配完成之间，该扩展的路由 / Provider 都不存在。
          // 网关据此返回可重试的 extension-reloading，而不是让调用方看到 404。
          beginSwap(extensionId);
          try {
            // 先撤旧：同名插件不能并存。
            await target.remove(extensionId);
            try {
              await mount(extensionId, directory);
              return { swapped: true };
            } catch (error) {
              if (previousDirectory) {
                try {
                  await mount(extensionId, previousDirectory);
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
          await layer()?.remove(extensionId);
        }
      };
    };
    const manager: ExtensionManager = createExtensionManager(
      {
        managedRoot,
        toolkit,
        ...(runtimeSwap() ? { runtime: runtimeSwap()! } : {}),
        marketplace: ctx.marketplace,
        trust: () => ({
          trustedKeys: parseTrustedKeys(settings.get("extensions.marketplace.trustedKeys" as never)),
          allowUnsignedLocal: envAllow || settings.get("extensions.marketplace.allowUnsigned" as never) === true
        }),
        builtinIds: () => {
          // 受管扩展也会出现在 metadata 里：内置集合 = 扫描到的扩展 − 受管记录。
          const managed = new Set(manager.installed().map((entry) => entry.extensionId));
          return new Set([...builtinIds].filter((id) => !managed.has(id)));
        },
        installedVersions: () => {
          const versions = new Map<string, string>();
          for (const entry of host.metadata ?? []) {
            const version = (entry as { site?: { version?: string } }).site?.version;
            if (typeof version === "string") versions.set(entry.extensionId, version);
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
      trustedKeys: () => parseTrustedKeys(settings.get("extensions.marketplace.trustedKeys" as never)),
      keyIdOf: (publicKey: string) => {
        try {
          return toolkit.keyIdOf ? toolkit.keyIdOf(publicKey) : null;
        } catch {
          return null;
        }
      },
      installedVersion: (extensionId: string) => manager.installed().find((entry) => entry.extensionId === extensionId)?.version
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