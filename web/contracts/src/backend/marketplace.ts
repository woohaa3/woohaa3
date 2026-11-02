/**
 * 扩展市场**安装面**契约（change: 2026-10-21-add-extension-marketplace-point，design D1/D2/D11）。
 *
 * 服务本身（`ctx.marketplace`、`MarketplaceSource`、`ReleaseRef` 等来源协议）在
 * `../extension/services/host/marketplace.js` 定义——那里才是扩展可见的服务面。这里只放核心
 * Extension Manager 自己的安装/状态 DTO，它们不是扩展可注入的服务。
 */
import type { ExtensionEngines } from "../extension/services/host/marketplace.js";

/** 核心自带的本地文件来源（上传 `.wxt`）。 */
export const MARKETPLACE_LOCAL_FILE_SOURCE_ID = "local-file";

/**
 * 缺省市场仓库（公开仓）：GitHub Release 来源开箱即用的候选仓库。
 * 配置 `extensions.marketplace.github.repos` 可整体替换它。
 */
export const DEFAULT_GITHUB_MARKETPLACE_REPOS = "woohaa3/woohaa3-marketplace";

/** 安装失败码（design D11）。稳定短标识，前端据此给出中文原因。 */
export const MARKETPLACE_FAILURE_CODES = [
  "MARKETPLACE_SOURCE_UNAVAILABLE",
  /** 来源可用，但没有满足 range 的可见版本（未审核 / 已撤回 / 不存在）。 */
  "MARKETPLACE_SOURCE_NOT_FOUND",
  "MARKETPLACE_ENGINES_INCOMPATIBLE",
  "MARKETPLACE_DEPENDENCY_UNSATISFIED",
  "MARKETPLACE_BUILTIN_CONFLICT",
  /** 更新包的签名发布者与已安装版本（或内置官方发布者）不一致。 */
  "MARKETPLACE_PUBLISHER_CHANGED",
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
export type ExtensionTrust = `signed:${string}` | `certified:${string}:${string}` | "unsigned";

/** 来源侧的一个可见版本（展示用；来源返回的状态与 keyId 不参与信任判定）。 */
export type MarketplaceVersionInfo = {
  readonly version: string;
  readonly engines?: ExtensionEngines;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly packageDigest: string;
  readonly size: number;
  /** 发布签名公钥 keyId（sha256(SPKI DER) 前 16 hex；v1 兼容展示口径）。 */
  readonly keyId?: string;
  /** 证书包（v2）的完整公钥指纹、证书、发布者与信任域；裸 key 版本为空。 */
  readonly signerKeyId?: string;
  readonly certificateId?: string;
  readonly publisherId?: string;
  readonly trustDomain?: string;
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
  /**
   * 本机当前生效的版本（受管优先；没有受管版本时取内置版本）。
   * 内置与受管同 id 时，只有更高的受管版本才会覆盖内置版本。
   */
  readonly installedVersion?: string;
  /** 当前生效版本来自哪里：`builtin` 为随客户端打包的内置版本，`managed` 为市场安装的受管版本。 */
  readonly installedKind?: "builtin" | "managed";
  /** 来源当前可安装的最高已审核版本（仅展示；撤回/待审不参与）。 */
  readonly latestVersion?: string;
  /** 是否存在比本机当前版本更高的可安装版本（严格 semver）。 */
  readonly updateAvailable?: boolean;
};
