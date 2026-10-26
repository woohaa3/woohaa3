/**
 * 市场版本详情（change: 2026-10-21-add-server-extension-marketplace，D7/D8 / tasks 7.4）。
 *
 * 本机宿主只读投影：来源返回的版本列表 + 发布公钥，叠加「本机是否信任该 keyId」与本机已装版本。
 * 信任只看本机 `extensions.marketplace.trustedKeys`；来源声明的状态与 keyId 只用于展示（D6）。
 */
import {
  MARKETPLACE_LOCAL_FILE_SOURCE_ID,
  type HostMarketplaceService,
  maxSatisfying,
  type ManagedVersionStatusView,
  type MarketplaceExtensionDetailView,
  type MarketplaceSigningKey,
  type MarketplaceSource,
  type MarketplaceSourceDetails
} from "@woohaa3/contracts";
import { ExtensionManagerError } from "./errors.js";
import type { TrustedKey } from "./types.js";

export type MarketplaceDetailDeps = {
  marketplace: HostMarketplaceService;
  trustedKeys: () => readonly TrustedKey[];
  /** 本机信任根公钥 → keyId（与包工具 `keyIdOf` 同一算法）；无法解析的公钥返回 null。 */
  keyIdOf: (publicKey: string) => string | null;
  installedVersion: (extensionId: string) => string | undefined;
};

export function trustedKeyIdSet(deps: Pick<MarketplaceDetailDeps, "trustedKeys" | "keyIdOf">): Set<string> {
  const ids = new Set<string>();
  for (const key of deps.trustedKeys()) {
    const id = key.keyId ?? deps.keyIdOf(key.publicKey);
    if (id) ids.add(id);
  }
  return ids;
}

export async function marketplaceExtensionDetail(
  deps: MarketplaceDetailDeps,
  input: { sourceId: string; extensionId: string },
  signal: AbortSignal
): Promise<MarketplaceExtensionDetailView> {
  const source = deps.marketplace.resolve(input.sourceId) as (MarketplaceSource & MarketplaceSourceDetails) | undefined;
  if (!source || source.sourceId === MARKETPLACE_LOCAL_FILE_SOURCE_ID || typeof source.getExtension !== "function") {
    throw new ExtensionManagerError("MARKETPLACE_SOURCE_UNAVAILABLE", `市场来源不存在或不提供版本详情：${input.sourceId}`);
  }
  const availability = source.available();
  if (!availability.ok) throw new ExtensionManagerError("MARKETPLACE_SOURCE_UNAVAILABLE", availability.reason);
  let extension;
  try {
    extension = await source.getExtension(input.extensionId, signal);
  } catch (error) {
    throw new ExtensionManagerError("MARKETPLACE_SOURCE_UNAVAILABLE", error instanceof Error ? error.message : String(error));
  }
  if (!extension) throw new ExtensionManagerError("MARKETPLACE_SOURCE_NOT_FOUND", `来源 ${input.sourceId} 没有扩展 ${input.extensionId}`);
  let signingKeys: readonly MarketplaceSigningKey[] = [];
  if (typeof source.signingKeys === "function") {
    try {
      signingKeys = await source.signingKeys(signal);
    } catch {
      signingKeys = [];
    }
  }
  const trusted = trustedKeyIdSet(deps);
  const installedVersion = deps.installedVersion(input.extensionId);
  return {
    sourceId: input.sourceId,
    extension,
    trustedKeyIds: [...new Set(extension.versions.map((entry) => entry.keyId).filter((id): id is string => !!id && trusted.has(id)))],
    signingKeys: signingKeys.map((key) => ({ ...key, trusted: trusted.has(key.keyId) })),
    ...(installedVersion ? { installedVersion } : {})
  };
}

const APPROVED_STATE = "RELEASE_STATE_APPROVED";
const YANKED_STATES = new Set(["RELEASE_STATE_YANKED", "yanked"]);

/**
 * 受管扩展当前版本在来源侧的状态（已撤回提示）。只读、按需：设置面打开受管卡片 / 快照刷新时调用，
 * 不轮询。任何失败都收敛成 `unknown`（设置面不显示提示），从不抛错、从不影响已安装副本。
 */
export async function managedVersionStatus(
  deps: Pick<MarketplaceDetailDeps, "marketplace">,
  input: { sourceId: string; extensionId: string; version: string },
  signal: AbortSignal,
  now: () => Date = () => new Date()
): Promise<ManagedVersionStatusView> {
  const base = { extensionId: input.extensionId, version: input.version, sourceId: input.sourceId, checkedAt: now().toISOString() };
  const unknown: ManagedVersionStatusView = { ...base, status: "unknown" };
  const source = deps.marketplace.resolve(input.sourceId) as (MarketplaceSource & MarketplaceSourceDetails) | undefined;
  if (!source || source.sourceId === MARKETPLACE_LOCAL_FILE_SOURCE_ID || typeof source.getExtension !== "function") return unknown;
  try {
    if (!source.available().ok) return unknown;
    const extension = await source.getExtension(input.extensionId, signal, [input.version]);
    // 扩展整体不在来源里：可能是权限或部署差异，信息不足以断言「已撤回」，不显示。
    if (!extension) return unknown;
    const visible = extension.versions.filter((entry) => !entry.state || entry.state === APPROVED_STATE);
    const latest = maxSatisfying(visible.map((entry) => entry.version), "*") ?? undefined;
    const own = extension.versions.find((entry) => entry.version === input.version);
    if (own && own.state && YANKED_STATES.has(own.state)) {
      return { ...base, status: "withdrawn", ...(own.yankReason ? { reason: own.yankReason } : {}), ...(latest ? { latest } : {}) };
    }
    if (own && (!own.state || own.state === APPROVED_STATE)) return { ...base, status: "available", ...(latest ? { latest } : {}) };
    // 来源只对普通用户返回已审核版本：已装版本不在可见列表里 = 已不可用（撤回）。拒绝 / 待审不会出现在已装副本上。
    if (!own) return { ...base, status: "withdrawn", ...(latest ? { latest } : {}) };
    return unknown;
  } catch {
    return unknown;
  }
}

/** 版本状态的短期缓存：同一 (来源, 扩展, 版本) 在 TTL 内只查一次；并发请求共享同一次查询。 */
export function createVersionStatusCache(
  query: (input: { sourceId: string; extensionId: string; version: string }) => Promise<ManagedVersionStatusView>,
  options: { ttlMs?: number; now?: () => number } = {}
) {
  const ttl = options.ttlMs ?? 5 * 60 * 1000;
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, { at: number; value: Promise<ManagedVersionStatusView> }>();
  return (input: { sourceId: string; extensionId: string; version: string }): Promise<ManagedVersionStatusView> => {
    const key = `${input.sourceId}\u0000${input.extensionId}\u0000${input.version}`;
    const hit = entries.get(key);
    if (hit && now() - hit.at < ttl) return hit.value;
    const value = query(input).then((result) => {
      // 不缓存 unknown：网络恢复 / 登录后下一次打开卡片就能拿到真实状态。
      if (result.status === "unknown") entries.delete(key);
      return result;
    });
    entries.set(key, { at: now(), value });
    return value;
  };
}
