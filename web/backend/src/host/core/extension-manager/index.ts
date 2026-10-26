/**
 * 核心层 · extensionManager：受管扩展的安装、卸载、回滚与观察期
 * （change: 2026-10-21-add-extension-marketplace-point，D6–D10）。
 *
 * - 受管根取自扩展宿主扫描结果（`extensionHost.managedRoot`，与扫描器同一个值）；没有受管根时不装配。
 * - 信任根与未签名开关来自本机配置（`extensions.marketplace.*`），按调用现取，不经站点配置面写入。
 * - 本地文件来源（`local-file`）在这里注册进 `ctx.marketplace`（核心自带，非扩展）。
 * - 受管根被另一个进程锁住时 Manager 不可写（`MARKETPLACE_WRITER_LOCKED` 记日志），宿主照常启动。
 */
import type { ExtensionDocumentStore } from "@woohaa3/contracts";
import type { LoadedExtensionHost } from "../../../extensions/manifest.js";
import { createExtensionInstallApiHandler } from "../../../api/extension-install-api.js";
import type { HostPlugin } from "../../context.js";
import { ROUTE_ORDER } from "../../order.js";
import { createExtensionManager, type ExtensionManager, type ObservedHealth } from "./manager.js";
import { loadPackageToolkit } from "./toolkit.js";
import { createRuntimeAttach } from "./runtime-attach.js";
import { createVersionStatusCache, managedVersionStatus, marketplaceExtensionDetail } from "./marketplace-detail.js";
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

    const runtimeAttach = createRuntimeAttach(ctx, toolkit, log);
    const manager: ExtensionManager = createExtensionManager(
      {
        managedRoot,
        toolkit,
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
        // 子进程隔离（change: 2026-10-21-isolate-extension-host-process，D10）：服务只在隔离开启时 provide；
        // 每次调用现取（不依赖装载顺序），服务不存在或未启用时等同未隔离（P1 受控重启语义）。
        isolation: {
          isolated: (extensionId) => {
            const service = ctx.get("extensionHostIsolation");
            return service?.enabled() === true && service.isolated(extensionId);
          },
          swap: (extensionId, nextDirectory) => {
            const service = ctx.get("extensionHostIsolation");
            if (!service) return Promise.reject(Object.assign(new Error("子进程隔离未启用"), { code: "MARKETPLACE_NOT_INSTALLED" }));
            return service.swap(extensionId, nextDirectory);
          },
          remove: async (extensionId) => {
            await ctx.get("extensionHostIsolation")?.remove(extensionId);
          },
          // 首次安装热装（任务 8.4）：隔离服务支持运行期 add 且宿主有扩展层入口时才提供，否则 Manager 退回重启。
          ...(runtimeAttach ? { attach: runtimeAttach.attach, detach: runtimeAttach.detach, canAttach: runtimeAttach.supported } : {})
        },
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
      // 解除崩溃隔离（change: 2026-10-21-isolate-extension-host-process，D7）：隔离关闭时服务不存在 → 路由不可用。
      unquarantine: () => {
        const isolation = ctx.get("extensionHostIsolation");
        if (!isolation) return undefined;
        return async (extensionId: string, actor?: string) => {
          if (!isolation.isolated(extensionId)) return { ok: false as const, code: "MARKETPLACE_NOT_INSTALLED", message: `扩展 ${extensionId} 不是受管隔离扩展` };
          const result = await isolation.unquarantine(extensionId, actor);
          return { ok: true as const, unquarantined: result.unquarantined, status: ctx.get("application")?.service.plugins().status(extensionId) };
        };
      },
      authenticator: ctx.access.authenticator,
      accessEnforcer: ctx.access.accessEnforcer,
      logger: log
    });
    ctx.effect(() => ctx.gateway.route(ROUTE_ORDER.extensionInstall, handler));
  }
};