/**
 * 扩展市场扩展点契约（change: 2026-10-21-add-extension-marketplace-point，design D1/D2/D11）。
 *
 * 形状照 `ctx.generation` 的 fan-in 注册表：多个来源同时可用，搜索合并全部可用来源，安装时由调用方
 * 指定 `sourceId`；**没有** primary 选择。来源只回答「从哪里拿到字节」——校验、暂存、预检、提交与
 * 重载都在核心的 Extension Manager，来源返回的任何「已验证」信息都不被信任。
 *
 * 提供来源的插件只能来自内置根（design D3）：受管根 / 可写根里的扩展注册来源会被宿主拒绝。
 */

/** 扩展声明的运行环境要求（`extension.json` 的 `engines`）。 */
export type ExtensionEngines = {
  /** 宿主后端 SDK ABI 的 semver range。 */
  readonly hostAbi: string;
  /** 浏览器 SDK ABI 的 semver range，与 browser artifact manifest 的 `sdkAbi` 对齐。 */
  readonly sdkAbi: string;
  readonly protocolVersion: number;
};

/** 来源解析出的一个可安装版本。字段即后续 woohaa-server proto `ResolveRelease` 需要的最小集合。 */
export type ReleaseRef = {
  readonly sourceId: string;
  readonly extensionId: string;
  readonly version: string;
  readonly engines: ExtensionEngines;
  /** `sha256:<hex>`：整个 `.wxt` 包的摘要。来源的声明，下载后由 Manager 复核。 */
  readonly packageDigest: string;
  readonly size: number;
  /** extensionId → semver range。 */
  readonly dependencies?: Readonly<Record<string, string>>;
};

export type MarketplaceListing = {
  readonly extensionId: string;
  readonly label: string;
  readonly description?: string;
  readonly latest: string;
  readonly icon?: string;
};

export type MarketplaceSearchQuery = { readonly text?: string; readonly cursor?: string; readonly limit?: number };
export type MarketplaceSearchPage = { readonly items: readonly MarketplaceListing[]; readonly nextCursor?: string };
export type MarketplaceAvailability = { readonly ok: true } | { readonly ok: false; readonly reason: string };
export type MarketplaceDownload = { readonly stream: ReadableStream<Uint8Array>; readonly size: number };

/** 一个市场来源。由内置根扩展在 `apply` 里经 `ctx.marketplace.register` 注册（放进 `ctx.effect`）。 */
export type MarketplaceSource = {
  readonly sourceId: string;
  readonly label: string;
  available(): MarketplaceAvailability;
  search(query: MarketplaceSearchQuery, signal: AbortSignal): Promise<MarketplaceSearchPage>;
  /** 按 semver range 解析一个版本；没有匹配返回 `null`。 */
  resolve(extensionId: string, range: string, signal: AbortSignal): Promise<ReleaseRef | null>;
  download(ref: ReleaseRef, signal: AbortSignal): Promise<MarketplaceDownload>;
};

/** `ctx.marketplace`：市场来源注册面。 */
export type HostMarketplaceService = {
  /** 注册来源；重复 `sourceId` 抛错。返回注销函数。 */
  register(source: MarketplaceSource): () => void;
  unregister(sourceId: string): void;
  list(): readonly MarketplaceSource[];
  resolve(sourceId: string): MarketplaceSource | undefined;
};

/** 核心自带的本地文件来源（上传 `.wxt`）。 */
export const MARKETPLACE_LOCAL_FILE_SOURCE_ID = "local-file";

/** 安装失败码（design D11）。稳定短标识，前端据此给出中文原因。 */
export const MARKETPLACE_FAILURE_CODES = [
  "MARKETPLACE_SOURCE_UNAVAILABLE",
  /** 来源可用，但没有满足 range 的可见版本（未审核 / 已撤回 / 不存在）。 */
  "MARKETPLACE_SOURCE_NOT_FOUND",
  "MARKETPLACE_ENGINES_INCOMPATIBLE",
  "MARKETPLACE_DEPENDENCY_UNSATISFIED",
  "MARKETPLACE_BUILTIN_CONFLICT",
  "MARKETPLACE_DOWNLOAD_FAILED",
  "MARKETPLACE_PACKAGE_TOO_LARGE",
  "MARKETPLACE_DIGEST_MISMATCH",
  "MARKETPLACE_SIGNATURE_INVALID",
  "MARKETPLACE_UNSIGNED_REJECTED",
  "MARKETPLACE_ARCHIVE_UNSAFE",
  "MARKETPLACE_PREFLIGHT_FAILED",
  "MARKETPLACE_FORBIDDEN_DECLARATION",
  "MARKETPLACE_VERSION_CONTENT_CONFLICT",
  "MARKETPLACE_REVISION_CONFLICT",
  "MARKETPLACE_RESTART_UNSUPPORTED",
  "MARKETPLACE_NOT_INSTALLED",
  "MARKETPLACE_NO_PREVIOUS_VERSION",
  "MARKETPLACE_WRITER_LOCKED",
  "MARKETPLACE_INSTALLATIONS_CORRUPT",
  "MARKETPLACE_UNINSTALL_DRAINING",
  "MARKETPLACE_UNAVAILABLE",
  "MARKETPLACE_CANCELLED",
  /** 包缺少必需产物（如旧包没有 backend-dist/config-schema.json）。 */
  "MARKETPLACE_PACKAGE_INVALID",
  /** 子进程蓝绿切换失败（新进程未就绪 / 健康检查失败），保留旧版本。 */
  "MARKETPLACE_SWAP_FAILED"
] as const;
export type MarketplaceFailureCode = (typeof MARKETPLACE_FAILURE_CODES)[number];

export function isMarketplaceFailureCode(value: unknown): value is MarketplaceFailureCode {
  return typeof value === "string" && (MARKETPLACE_FAILURE_CODES as readonly string[]).includes(value);
}

/** 安装流水线阶段（design D6）。`migrate` 本期只预留，声明了即拒绝。 */
export const EXTENSION_INSTALL_PHASES = ["queued", "resolve", "download", "verify", "stage", "preflight", "commit", "reload", "observe"] as const;
export type ExtensionInstallPhase = (typeof EXTENSION_INSTALL_PHASES)[number];

/** 任务终态与中间态。 */
export type ExtensionInstallJobStatus = "running" | "succeeded" | "failed" | "cancelled";

/**
 * 成功时的结果：
 * - `installed`：纯前端扩展已热登记；
 * - `restart-required`：含后端代码，需要受控重启后生效；
 * - `already-current`：已是当前版本，未改 revision。
 */
export type ExtensionInstallOutcome = "installed" | "restart-required" | "already-current";

export type ExtensionInstallFailure = {
  readonly code: MarketplaceFailureCode;
  /** 安全的中文说明，不含密钥或远端正文。 */
  readonly message: string;
  /** `MARKETPLACE_PREFLIGHT_FAILED` 时附预检错误。 */
  readonly issues?: readonly string[];
};

/** `GET /api/extensions/install/:jobId` 的视图。 */
export type ExtensionInstallJobView = {
  readonly jobId: string;
  readonly action: "install" | "uninstall" | "rollback";
  readonly sourceId: string;
  readonly extensionId?: string;
  readonly version?: string;
  readonly status: ExtensionInstallJobStatus;
  readonly phase: ExtensionInstallPhase;
  /** 0–1；阶段内无法估算时缺省。 */
  readonly progress?: number;
  readonly outcome?: ExtensionInstallOutcome;
  readonly failure?: ExtensionInstallFailure;
  readonly startedAt: string;
  readonly finishedAt?: string;
};

/** 受管扩展的信任级别：`signed:<keyId>` 或 `unsigned`（仅 local-file 且本机显式允许）。 */
export type ExtensionTrust = `signed:${string}` | "unsigned";

/**
 * 扩展声明的权限（`extension.json` 的 `permissions`）。本期只做格式校验并记录展示，**不强制**；
 * 字段与后续进程隔离 change 的 ctx 裁剪一一对应。
 */
export type ExtensionPermissions = {
  readonly network?: readonly string[];
  readonly canvas?: "read" | "write";
  readonly mcpTools?: readonly string[];
  readonly publicRoutes?: boolean;
  readonly storageNamespaces?: readonly string[];
};

/** 来源侧的一个可见版本（展示用；来源返回的状态与 keyId 不参与信任判定）。 */
export type MarketplaceVersionInfo = {
  readonly version: string;
  readonly engines?: ExtensionEngines;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly packageDigest: string;
  readonly size: number;
  /** 发布签名公钥 keyId（sha256(SPKI DER) 前 16 hex）。 */
  readonly keyId?: string;
  readonly publishedAt?: string;
  /** 来源声明的状态（如 approved / yanked）；客户端只展示。 */
  readonly state?: string;
  /** 来源声明的撤回原因（仅已撤回版本；来源不提供时缺省）。 */
  readonly yankReason?: string;
};

/**
 * 受管扩展当前版本在来源侧的状态（change: 2026-10-21-add-server-extension-marketplace，已撤回提示）。
 *
 * - `available`：该版本仍在来源可用版本中；
 * - `withdrawn`：来源标记为已撤回，或扩展仍在但该版本已不在可用列表中（来源只对普通用户返回已审核版本）；
 * - `unknown`：来源不可用 / 查询失败 / 来源不提供版本详情——设置面**不显示**任何提示。
 * 只用于展示：不强制卸载，不影响已安装副本运行。
 */
export type ManagedVersionStatusView = {
  readonly extensionId: string;
  readonly version: string;
  readonly sourceId: string;
  readonly status: "available" | "withdrawn" | "unknown";
  readonly reason?: string;
  /** 来源当前最高可用版本（高于已装版本时设置面提示升级）。 */
  readonly latest?: string;
  readonly checkedAt: string;
};

export type MarketplaceExtensionInfo = {
  readonly extensionId: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: string;
  readonly versions: readonly MarketplaceVersionInfo[];
};

/** 来源可选的发布签名公钥（来源声明；本机是否信任由本机配置决定，D7）。 */
export type MarketplaceSigningKey = { readonly keyId: string; readonly label?: string; readonly publicKey: string };

/**
 * 来源的可选扩展能力：版本详情与发布公钥。`MarketplaceSource` 的最小形状（search / resolve / download）
 * 不变；实现了这两个方法的来源，本机宿主可以展示版本列表与「信任此公钥」入口。
 */
export type MarketplaceSourceDetails = {
  /** `includeVersions`：请来源同时带回这些版本的状态（含已撤回），供已撤回提示使用；来源可忽略。 */
  getExtension?(extensionId: string, signal: AbortSignal, includeVersions?: readonly string[]): Promise<MarketplaceExtensionInfo | null>;
  signingKeys?(signal: AbortSignal): Promise<readonly MarketplaceSigningKey[]>;
};

/** `GET /api/extensions/marketplace/extension` 的视图（本机宿主投影）。 */
export type MarketplaceExtensionDetailView = {
  readonly sourceId: string;
  readonly extension: MarketplaceExtensionInfo;
  /** 版本 keyId → 本机是否已信任（`extensions.marketplace.trustedKeys`）。 */
  readonly trustedKeyIds: readonly string[];
  /** 来源声明的发布公钥（只用于「信任此公钥」入口展示指纹；不自动信任）。 */
  readonly signingKeys: readonly (MarketplaceSigningKey & { readonly trusted: boolean })[];
  /** 本机已安装的受管版本（若有）。 */
  readonly installedVersion?: string;
};
