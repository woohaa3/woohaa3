/**
 * 「本部署市场」来源：把远端 woohaa-server 的 `woohaa.marketplace.v1alpha1.MarketplaceService`
 * 投影成宿主的一个 `MarketplaceSource`（change: 服务端扩展市场，客户端接入）。
 *
 * 与 GitHub 来源的分工相同：**来源只负责「找到并递交字节」**，摘要、签名、预检与提交全部在
 * 宿主的 Extension Manager 里复核；本模块声明的 digest / size / keyId 都只是**声明**，不被信任。
 *
 * 三条刻意的边界：
 * - 未登录时来源不可用（`available()` 给出可读原因），不发起任何请求；
 * - 每次调用都用**当次**会话令牌，登录/登出/换服不需要重建来源对象；
 * - 版本由客户端按 semver range 自己挑（服务端只如实列出可见版本），已撤回的版本不参与挑选。
 */
import type {
  MarketplaceAvailability,
  MarketplaceDownload,
  MarketplaceExtensionInfo,
  MarketplaceListing,
  MarketplaceSearchPage,
  MarketplaceSearchQuery,
  MarketplaceSigningKey,
  MarketplaceSource,
  MarketplaceSourceDetails,
  MarketplaceVersionInfo,
  ReleaseRef
} from "@woohaa3/contracts";
import { maxSatisfying } from "@woohaa3/contracts";
import type { RemoteSession } from "../session.js";
import { callConnect } from "../connect.js";
import { connectProcedurePath, MARKETPLACE_SERVICE } from "../../shared.js";

/**
 * 来源 id：与 GitHub（`github-release`）并列，界面上显示「本部署市场」。
 *
 * 取 `woohaa-server`（与设计文档一致），不要和存储后端的 `server` 混为一谈——
 * 两者是两个面：存储后端决定「字节去哪」，市场来源决定「扩展从哪来」。
 */
export const SERVER_MARKETPLACE_SOURCE_ID = "woohaa-server";

/** 单次列表请求的缺省页大小，与 proto 的缺省（50）一致。 */
const DEFAULT_PAGE_SIZE = 50;

type CallResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string };

export type ServerMarketplaceSourceOptions = {
  /** 只读当前会话（`sessionSource.current`）；`available()` 用它的同步镜像。 */
  currentSession: () => Promise<RemoteSession | null>;
  /** 会话变化时由扩展调用，更新 `available()` 的同步镜像。 */
  onSession?: (listener: (session: RemoteSession | null) => void) => void;
  fetchImpl: typeof globalThis.fetch;
  /** 测试注入：替换 Connect 调用。 */
  call?: <T>(session: RemoteSession, procedure: string, body: unknown, signal: AbortSignal) => Promise<CallResult<T>>;
  timeoutMs?: number;
};

export type ServerMarketplaceSource = MarketplaceSource &
  // 两个详情能力本实现**总是**提供（宿主据此渲染版本列表与「信任此公钥」入口）；
  // 契约里它们是可选的（其他来源可以只做最小形状），这里收窄成必有。
  Required<Pick<MarketplaceSourceDetails, "getExtension" | "signingKeys">> & {
    /** 由扩展在会话变化时喂入，供同步的 `available()` 使用。 */
    setSession(session: RemoteSession | null): void;
  };

/** proto 的 ReleaseState 里「可安装」的状态。pending/rejected/yanked 都不参与挑选。 */
const APPROVED_STATES = new Set(["RELEASE_STATE_APPROVED", "approved"]);

/** protobuf-es 的 JSON 映射把 int64/uint64 写成字符串。 */
function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Timestamp 在 Connect JSON 里是 RFC3339 字符串；也容忍 `{ seconds }`。 */
function toIsoTime(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") return value;
  if (value && typeof value === "object" && "seconds" in value) {
    const seconds = toNumber((value as { seconds?: unknown }).seconds);
    if (seconds > 0) return new Date(seconds * 1000).toISOString();
  }
  return undefined;
}

type VersionJson = {
  version?: unknown;
  engines?: { hostAbi?: unknown; sdkAbi?: unknown; protocolVersion?: unknown } | null;
  dependencies?: Array<{ extensionId?: unknown; range?: unknown }> | null;
  packageDigest?: unknown;
  size?: unknown;
  keyId?: unknown;
  publishedAt?: unknown;
  state?: unknown;
  yankReason?: unknown;
};

function toVersionInfo(entry: VersionJson): MarketplaceVersionInfo | null {
  const version = toStringOrNull(entry.version);
  const packageDigest = toStringOrNull(entry.packageDigest);
  if (!version || !packageDigest) return null;
  const engines = entry.engines ?? null;
  const dependencies = (entry.dependencies ?? [])
    .map((dependency) => {
      const extensionId = toStringOrNull(dependency.extensionId);
      const range = toStringOrNull(dependency.range);
      return extensionId && range ? ([extensionId, range] as const) : null;
    })
    .filter((pair): pair is readonly [string, string] => pair !== null);
  const state = toStringOrNull(entry.state) ?? undefined;
  const yankReason = toStringOrNull(entry.yankReason) ?? undefined;
  const publishedAt = toIsoTime(entry.publishedAt);
  const keyId = toStringOrNull(entry.keyId) ?? undefined;
  return {
    version,
    ...(engines
      ? {
          engines: {
            hostAbi: typeof engines.hostAbi === "string" ? engines.hostAbi : "",
            sdkAbi: typeof engines.sdkAbi === "string" ? engines.sdkAbi : "",
            protocolVersion: toNumber(engines.protocolVersion)
          }
        }
      : {}),
    ...(dependencies.length > 0 ? { dependencies: Object.fromEntries(dependencies) } : {}),
    packageDigest,
    size: toNumber(entry.size),
    ...(keyId ? { keyId } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(state ? { state } : {}),
    ...(yankReason ? { yankReason } : {})
  };
}

function isInstallable(info: MarketplaceVersionInfo): boolean {
  // 没有 state 字段时按可安装处理（更早的服务端不返回 state）；显式非 approved 一律排除。
  if (info.state === undefined) return true;
  return APPROVED_STATES.has(info.state);
}

export function createServerMarketplaceSource(options: ServerMarketplaceSourceOptions): ServerMarketplaceSource {
  let session: RemoteSession | null = null;

  const call =
    options.call ??
    (<T>(current: RemoteSession, procedure: string, body: unknown, signal: AbortSignal) =>
      callConnect<T>(options.fetchImpl, current.serverUrl, procedure, body, {
        token: current.token,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        signal
      }) as Promise<CallResult<T>>);

  /** 取当次会话：同步镜像缺失时再问一次来源，避免「刚登录但镜像还没喂进来」。 */
  const sessionNow = async (): Promise<RemoteSession | null> => {
    if (session) return session;
    session = await options.currentSession();
    return session;
  };

  const requireSession = async (): Promise<RemoteSession> => {
    const current = await sessionNow();
    if (!current) throw new Error("未连接服务端，无法使用本部署市场");
    return current;
  };

  const callOrThrow = async <T>(procedure: string, body: unknown, signal: AbortSignal): Promise<T> => {
    const current = await requireSession();
    const result = await call<T>(current, procedure, body, signal);
    if (!result.ok) throw new Error(result.message || `市场请求失败：${result.code}`);
    return result.value;
  };

  /** 版本详情：`resolve` 与详情接口共用同一份映射，避免两处对 state 的理解分叉。 */
  const getExtension = async (
    extensionId: string,
    signal: AbortSignal,
    includeVersions?: readonly string[]
  ): Promise<MarketplaceExtensionInfo | null> => {
    const current = await requireSession();
    const result = await call<{
      extension?: { extensionId?: unknown; label?: unknown; description?: unknown; icon?: unknown };
      versions?: VersionJson[];
    }>(
      current,
      connectProcedurePath(MARKETPLACE_SERVICE, "GetExtension"),
      {
        extensionId,
        ...(includeVersions && includeVersions.length > 0 ? { includeVersions: [...includeVersions] } : {})
      },
      signal
    );
    // 远端说「没有这个扩展」是**业务结论**，不是来源故障：返回 null，让宿主给出
    // MARKETPLACE_SOURCE_NOT_FOUND（界面显示「来源里没有这个扩展」）。
    // 其余错误（鉴权、不可达、协议不符）才向上抛，由宿主折成 SOURCE_UNAVAILABLE。
    if (!result.ok) {
      if (result.code === "not_found") return null;
      throw new Error(result.message || `市场请求失败：${result.code}`);
    }
    const value = result.value;
    const summary = value.extension;
    const versions = (value.versions ?? [])
      .map((entry) => toVersionInfo(entry))
      .filter((entry): entry is MarketplaceVersionInfo => entry !== null);
    if (!summary || versions.length === 0) return null;
    const description = toStringOrNull(summary.description);
    const icon = toStringOrNull(summary.icon);
    return {
      extensionId: toStringOrNull(summary.extensionId) ?? extensionId,
      label: toStringOrNull(summary.label) ?? extensionId,
      versions,
      ...(description ? { description } : {}),
      ...(icon ? { icon } : {})
    };
  };

  const source: ServerMarketplaceSource = {
    sourceId: SERVER_MARKETPLACE_SOURCE_ID,
    label: "本部署市场",

    available(): MarketplaceAvailability {
      if (session) return { ok: true };
      return { ok: false, reason: "未连接服务端（先在「服务端接入」里登录）" };
    },

    setSession(next) {
      session = next;
    },

    async search(query: MarketplaceSearchQuery, signal: AbortSignal): Promise<MarketplaceSearchPage> {
      const limit = query.limit && query.limit > 0 ? Math.min(Math.trunc(query.limit), 200) : DEFAULT_PAGE_SIZE;
      const value = await callOrThrow<{
        extensions?: Array<{ extensionId?: unknown; label?: unknown; description?: unknown; latestVersion?: unknown; icon?: unknown }>;
        nextPageToken?: unknown;
      }>(
        connectProcedurePath(MARKETPLACE_SERVICE, "SearchExtensions"),
        {
          ...(query.text ? { text: query.text } : {}),
          pageSize: limit,
          ...(query.cursor ? { pageToken: query.cursor } : {})
        },
        signal
      );
      const items: MarketplaceListing[] = [];
      for (const entry of value.extensions ?? []) {
        const extensionId = toStringOrNull(entry.extensionId);
        const label = toStringOrNull(entry.label) ?? extensionId;
        const latest = toStringOrNull(entry.latestVersion);
        if (!extensionId || !latest) continue;
        const description = toStringOrNull(entry.description);
        const icon = toStringOrNull(entry.icon);
        items.push({
          extensionId,
          label: label ?? extensionId,
          latest,
          ...(description ? { description } : {}),
          ...(icon ? { icon } : {})
        });
      }
      const nextCursor = toStringOrNull(value.nextPageToken);
      return { items, ...(nextCursor ? { nextCursor } : {}) };
    },

    getExtension,

    async resolve(extensionId: string, range: string, signal: AbortSignal): Promise<ReleaseRef | null> {
      const info = await getExtension(extensionId, signal);
      if (!info) return null;
      const candidates = info.versions.filter(isInstallable).map((entry) => entry.version);
      const picked = maxSatisfying(candidates, range);
      if (!picked) return null;
      const version = info.versions.find((entry) => entry.version === picked);
      if (!version) return null;
      return {
        sourceId: SERVER_MARKETPLACE_SOURCE_ID,
        extensionId,
        version: version.version,
        engines: version.engines ?? { hostAbi: "*", sdkAbi: "*", protocolVersion: 0 },
        packageDigest: version.packageDigest,
        size: version.size,
        ...(version.dependencies ? { dependencies: version.dependencies } : {})
      };
    },

    async download(ref: ReleaseRef, signal: AbortSignal): Promise<MarketplaceDownload> {
      const value = await callOrThrow<{ url?: unknown; size?: unknown }>(
        connectProcedurePath(MARKETPLACE_SERVICE, "CreateDownloadUrl"),
        { extensionId: ref.extensionId, version: ref.version },
        signal
      );
      const url = toStringOrNull(value.url);
      if (!url) throw new Error("服务端没有返回下载地址");
      // 签名地址可能是站内相对路径（同源反代部署）：按会话地址解析。
      const current = await requireSession();
      const absolute = new URL(url, current.serverUrl).toString();
      const response = await options.fetchImpl(absolute, { signal });
      if (!response.ok || !response.body) {
        throw new Error(`下载扩展包失败：HTTP ${response.status}`);
      }
      return { stream: response.body, size: toNumber(value.size) || ref.size };
    },

    async signingKeys(signal: AbortSignal): Promise<readonly MarketplaceSigningKey[]> {
      const value = await callOrThrow<{
        signingKeys?: Array<{ keyId?: unknown; label?: unknown; publicKeySpkiBase64?: unknown }>;
      }>(connectProcedurePath(MARKETPLACE_SERVICE, "GetMarketplaceInfo"), {}, signal);
      const keys: MarketplaceSigningKey[] = [];
      for (const entry of value.signingKeys ?? []) {
        const keyId = toStringOrNull(entry.keyId);
        const publicKey = toStringOrNull(entry.publicKeySpkiBase64);
        if (!keyId || !publicKey) continue;
        const label = toStringOrNull(entry.label);
        keys.push({ keyId, publicKey, ...(label ? { label } : {}) });
      }
      return keys;
    }
  };

  return source;
}

/** 只依赖注册面与日志出口：宿主其余能力与本模块无关（也便于单测注入）。 */
export type MarketplaceRegistrationHost = {
  registerMarketplaceSource?: (source: MarketplaceSource) => void;
};

export type RemoteLogSink = (input: {
  event: string;
  level?: "debug" | "info" | "warn" | "error";
  code?: string;
  reason?: string;
}) => void;

/**
 * 把本部署市场来源交给宿主。
 *
 * 三种失败都**不是**激活失败（与 `registerMarketplaceSource` 的契约一致）：
 * - 宿主没有这个扩展点（旧宿主 / 独立入口）；
 * - 宿主判定本扩展不在内置根（市场装市场的场景，设计 D3 明确拒绝）；
 * - sourceId 已被占用（热重载残留）。
 * 只记日志并跳过：其余能力（画布同步、托管生成、存储后端）照常工作。
 */
export function registerServerMarketplaceSource(
  host: MarketplaceRegistrationHost,
  source: MarketplaceSource,
  log: RemoteLogSink
): boolean {
  if (!host.registerMarketplaceSource) {
    log({ event: "remote-marketplace-unsupported", level: "debug", reason: "宿主没有市场扩展点，跳过来源注册" });
    return false;
  }
  try {
    host.registerMarketplaceSource(source);
    log({ event: "remote-marketplace-registered", level: "info", reason: "本部署市场来源已注册" });
    return true;
  } catch (error) {
    log({
      event: "remote-marketplace-register-failed",
      level: "warn",
      code: error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "unknown",
      reason: "市场来源注册被宿主拒绝，本部署市场不可用"
    });
    return false;
  }
}
