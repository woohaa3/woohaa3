/**
 * Extension Manager 的对外类型与默认常量（从 manager.ts 拆出；manager.ts 原样 re-export）。
 */
import type { Readable } from "node:stream";
import type {
  ExtensionInstallJobView,
  ExtensionInstallationsView,
  ExtensionTrust,
  HostMarketplaceService,
  MarketplaceFailureCode,
  MarketplaceListing
} from "@woohaa3/contracts";
import type { BuiltinExtension, ExtensionPackageToolkit, TrustedKey } from "./types.js";

/** 站点扩展健康（观察期用）：`failed` 立即回滚，`degraded` 连续 N 次回滚，`unknown`（纯前端等）视为正常。 */
export type ObservedHealth = "ok" | "degraded" | "failed" | "unknown";

/**
 * 进程内热切换端口（C 方向）：扩展层已提供 `add` / `remove`（Cordis fiber），
 * 结合「每个版本一个目录」带来的模块 URL 隔离，换版可以在不重启宿主的情况下完成。
 *
 * 与蓝绿的区别是**没有重叠期**：同名插件不能并存，只能先 `remove` 再 `add`，
 * 期间该扩展缺席（在途调用失败）。端口负责把这段空窗压缩到最短，并在失败时装回旧版本。
 */
export type ExtensionRuntimePort = {
  /** 宿主是否具备运行期装配能力（扩展层存在且能加载插件）。 */
  available(): boolean;
  /**
   * 把该扩展切到 `directory`（版本见 `version`）。失败时尽力装回 `previousDirectory`，
   * 并抛错交由 Manager 按失败处理。
   */
  swap(extensionId: string, directory: string, version: string, previousDirectory: string | null): Promise<{ swapped: boolean }>;
  /** 卸载时把该扩展从扩展层撤下（幂等）。 */
  remove(extensionId: string): Promise<void>;
};

export type ExtensionManagerDeps = {
  managedRoot: string;
  /** 进程内热切换端口；缺省表示不支持热切换，含后端的变化退回受控重启。 */
  runtime?: ExtensionRuntimePort;
  toolkit: ExtensionPackageToolkit;
  /** 未限定的市场注册表：本地文件来源由 Manager 注册在这里。 */
  marketplace: HostMarketplaceService;
  /** 本机信任根与未签名开关（本机配置 + 内置官方公钥，按调用现取）。 */
  trust: () => { trustedKeys: readonly TrustedKey[]; allowUnsignedLocal: boolean };
  /**
   * 官方发布者 keyId 集合（内置官方公钥）。测试可注入；缺省取 official-trust.ts。
   * 内置扩展的受管覆盖只接受这里列出的发布者，防止其它已信任 key 用同名包顶替。
   */
  officialPublisherKeyIds?: () => ReadonlySet<string>;
  /**
   * 内置根扩展（按 extensionId）。同 id 的市场版本只有在 semver **严格更高** 时才能覆盖；
   * 卸载受管版本时回到这里记录的内置目录。
   */
  builtins?: () => ReadonlyMap<string, BuiltinExtension>;
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
