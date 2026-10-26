/**
 * Extension Manager 的对外类型与默认常量（从 manager.ts 拆出；manager.ts 原样 re-export）。
 */
import type { Readable } from "node:stream";
import type {
  ExtensionInstallJobView,
  ExtensionInstallationsView,
  ExtensionPermissions,
  ExtensionTrust,
  HostMarketplaceService,
  MarketplaceFailureCode,
  MarketplaceListing
} from "@woohaa3/contracts";
import type { ExtensionPackageToolkit, TrustedKey } from "./types.js";

/** 站点扩展健康（观察期用）：`failed` 立即回滚，`degraded` 连续 N 次回滚，`unknown`（纯前端等）视为正常。 */
export type ObservedHealth = "ok" | "degraded" | "failed" | "unknown";

/**
 * Extension Host 子进程隔离端口（change: 2026-10-21-isolate-extension-host-process，D10）。
 * 装配处接到 `ctx.extensionHost`（swap.ts）；隔离关闭（`extensions.host.isolation = false`）或宿主没有
 * 受管后端扩展时不传——含后端扩展按 P1 受控重启生效。
 */
export type ExtensionIsolationPort = {
  /** 本进程有没有为该扩展装配隔离控制器（首次安装的扩展在下次启动才有）。 */
  isolated(extensionId: string): boolean;
  /**
   * 蓝绿切换到新版本目录。`swapped: false` = 目录与当前相同（no-op）；站点停用时只记下新目录、返回 true。
   * 失败抛 `code = "MARKETPLACE_SWAP_FAILED"`（绿已清理、蓝未动）；未装配的扩展抛 `MARKETPLACE_NOT_INSTALLED`。
   */
  swap(extensionId: string, nextDirectory: string): Promise<{ swapped: boolean }>;
  /** 停止该扩展的子进程并撤镜像（卸载时；幂等）。 */
  remove?(extensionId: string): Promise<void>;
  /**
   * 首次安装热装（任务 8.4）：为新提交的版本目录装配代理插件并追加到扩展层（站点元数据存在时同时
   * 登记到站点门禁与控制面并按 desiredEnabled 激活），等到「就绪 + 首次健康」或站点停用 / 隔离为止。
   * 失败抛错（Manager 按热登记失败撤销记录）；不支持（隔离关闭）时缺省，Manager 退回 restart-required。
   */
  attach?(extensionId: string, directory: string, version: string): Promise<{ state: string }>;
  /** 当前能否运行期装配（隔离服务已启用且宿主有扩展层入口）；缺省视为与 `attach` 是否存在一致。 */
  canAttach?(): boolean;
  /** 卸载运行期装配的扩展：控制面移除 → 站点门禁移除 → 扩展层卸载 → 停子进程（幂等）。 */
  detach?(extensionId: string): Promise<void>;
};

export type ExtensionManagerDeps = {
  /** 子进程隔离端口；缺省 = 未隔离（P1 受控重启语义）。 */
  isolation?: ExtensionIsolationPort;
  managedRoot: string;
  toolkit: ExtensionPackageToolkit;
  /** 未限定的市场注册表：本地文件来源由 Manager 注册在这里。 */
  marketplace: HostMarketplaceService;
  /** 本机信任根与未签名开关（本机配置，按调用现取）。 */
  trust: () => { trustedKeys: readonly TrustedKey[]; allowUnsignedLocal: boolean };
  /** 内置根扩展 id：受管扩展不能与之同 id。 */
  builtinIds: () => ReadonlySet<string>;
  /** 当前已装配扩展的版本（内置 + 受管），用于依赖检查。 */
  installedVersions?: () => ReadonlyMap<string, string>;
  /** 纯前端扩展的热登记（mp-reload-ui 的 `publishBrowserRelease`）；缺省时一律按需要重启处理。 */
  publishBrowserRelease?: (change: { upsert?: Array<{ extensionId: string; directory: string }>; remove?: string[] }) => Promise<{ releaseId: string; href: string; changed: boolean }>;
  /** 受控重启（P0 的 hostRestart 控制器）。 */
  restart?: { supported(): boolean; request(input: { reason: string; actor: string }): boolean };
  /** 站点扩展停用：返回停用后的实际状态；扩展不受站点控制面管理时返回 `unmanaged`。 */
  disableSite?: (extensionId: string, actor: string) => Promise<"disabled" | "draining" | "unmanaged">;
  /** 站点扩展当前实际状态（卸载等待 draining 收尾）。 */
  siteState?: (extensionId: string) => "disabled" | "draining" | "active" | "other" | "unmanaged";
  /** 观察期健康。 */
  health?: (extensionId: string) => ObservedHealth;
  /** 「同时清除数据」：删除该扩展的 documents namespace 与配置段。 */
  purgeData?: (extensionId: string) => Promise<void>;
  now?: () => Date;
  logger?: (event: Record<string, unknown>) => void;
  limits?: { maxPackageBytes?: number };
  /** 观察窗口（毫秒），缺省 10 分钟。 */
  observeMs?: number;
  /** 健康连续失败几次回滚，缺省 3。 */
  observeFailureThreshold?: number;
  /** 不被引用的旧版本目录保留期，缺省 7 天。 */
  retentionMs?: number;
  /** 卸载等待 draining 收尾的上限，缺省 5 分钟；轮询间隔缺省 1 秒。 */
  drainTimeoutMs?: number;
  drainPollMs?: number;
  /** 测试可注入；缺省 setTimeout 实现的 sleep。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export type InstallRequest = { sourceId: string; extensionId: string; range: string; actor: string };
export type FileInstallRequest = { body: Readable | AsyncIterable<Uint8Array>; filename?: string; actor: string };

export type ManagedInstallView = {
  extensionId: string;
  version: string;
  previousVersion?: string;
  sourceId: string;
  trust?: ExtensionTrust;
  permissions?: ExtensionPermissions;
  restartRequired: boolean;
  observeUntil?: string;
  directory: string;
};

export type ExtensionManager = {
  installFromFile(request: FileInstallRequest): Promise<ExtensionInstallJobView>;
  installFromSource(request: InstallRequest): ExtensionInstallJobView;
  uninstall(extensionId: string, options: { purgeData?: boolean; actor: string }): ExtensionInstallJobView;
  rollback(extensionId: string, options: { toVersion?: string; actor: string }): ExtensionInstallJobView;
  job(jobId: string): ExtensionInstallJobView | undefined;
  /** 等任务结束（测试与同步调用方用）。 */
  wait(jobId: string): Promise<ExtensionInstallJobView | undefined>;
  cancel(jobId: string): ExtensionInstallJobView | null;
  search(query: { text?: string; sourceId?: string; cursor?: string; limit?: number }, signal?: AbortSignal): Promise<{
    items: MarketplaceListing[];
    nextCursor?: string;
    unavailable: Array<{ sourceId: string; reason: string }>;
    /** 已注册的市场来源（不含 local-file）及可用性；设置面「从市场安装」据此选择来源。 */
    sources?: Array<{ sourceId: string; label: string; ok: boolean; reason?: string }>;
  }>;
  requestRestart(actor: string): void;
  installed(): ManagedInstallView[];
  view(): ExtensionInstallationsView;
  /** 观察期一轮判定（定时器调用；测试直接调用）。 */
  observe(): Promise<void>;
  /**
   * 观察期内子进程崩溃（supervisor 回调，D7 与 P1 观察期衔接）：记录处于 observing 且有上一版本时回滚
   * （指针切回 + 对上一版本目录 swap）并返回 true；否则返回 false，由 supervisor 按崩溃窗口处理（可能隔离）。
   */
  handleObservationCrash(extensionId: string): Promise<boolean>;
  /** 清理保留期已过的孤儿版本目录。 */
  sweep(): number;
  close(): void;
};

export const DEFAULT_MAX_PACKAGE_BYTES = 200 * 1024 * 1024;
export const DEFAULT_OBSERVE_MS = 10 * 60 * 1000;
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const FAILURE_MESSAGES: Partial<Record<MarketplaceFailureCode, string>> = {
  MARKETPLACE_UNAVAILABLE: "本机未启用扩展安装（受管根不可用）"
};

export function sleepDefault(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}
