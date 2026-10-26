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

export type ExtensionManagerDeps = {
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
