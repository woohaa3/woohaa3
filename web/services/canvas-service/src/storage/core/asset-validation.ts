/**
 * 稳定 COS 资产引用校验（任务 2.5 / design D7）。
 *
 * 画布后端只持有**稳定引用**：`metadata.storageKey` / `checksum` / `contentType` / `size`。
 * 二进制 bytes 的唯一归属是 COS。本模块在命令进入数据库事务**之前**校验：
 *
 * 1. 形状：必须同时有 storageKey / checksum / contentType / size
 * 2. 前缀：storageKey 必须属于受控内容寻址前缀（`sha256-` 或 `generation-outputs/`）
 * 3. 一致性：checksum 必须与内容寻址 key 内嵌的哈希一致
 * 4. 存在性：注入的 `MediaStorage.exists/stat` 必须命中，且 size/contentType 与声明一致
 *
 * 刻意拒绝浏览器可提交的任意 `https:`、`data:`、`blob:` URL 或临时签名 URL：它们
 * 不是稳定引用，绝不允许进入画布或 operation。
 */
import type { MediaStorage, MediaStorageScope } from "@woohaa3/contracts";
import type { StoredAsset } from "@woohaa3/contracts";
import { CanvasStorageError } from "./errors.js";

/** 受控前缀：与站点媒体写入策略（`server/media.ts`）保持一致。 */
export const UPLOAD_STORAGE_KEY_PREFIX = "sha256-";
export const GENERATED_STORAGE_KEY_PREFIX = "generation-outputs/";

const STORAGE_KEY_PATTERN = /^sha256-([0-9a-f]{64})$/;
const GENERATED_KEY_PATTERN = /^generation-outputs\/([0-9a-f]{64})\.[a-z0-9]+$/;

/** 稳定资产 metadata 的形状。 */
export type StableAssetMetadata = {
  storageKey: string;
  checksum: string;
  contentType: string;
  size: number;
};

/** 只有「需要媒体对象」的资产才做 COS 校验；text 资产的正文在 `text` 字段。 */
export function assetNeedsMediaObject(asset: StoredAsset): boolean {
  return typeof asset.metadata?.storageKey === "string" || asset.mediaKind === "image" || asset.mediaKind === "video" || asset.mediaKind === "audio";
}

export function isControlledStorageKey(storageKey: string): boolean {
  return STORAGE_KEY_PATTERN.test(storageKey) || GENERATED_KEY_PATTERN.test(storageKey);
}

/** 从内容寻址 key 中取出内嵌的 sha256；非内容寻址 key 返回 null。 */
export function storageKeyChecksum(storageKey: string): string | null {
  const upload = STORAGE_KEY_PATTERN.exec(storageKey);
  if (upload) return upload[1];
  const generated = GENERATED_KEY_PATTERN.exec(storageKey);
  if (generated) return generated[1];
  return null;
}

/** 从 `metadata` 读出并校验形状；缺失或类型错误时返回拒绝原因。 */
export function readStableAssetMetadata(
  asset: StoredAsset
): { ok: true; metadata: StableAssetMetadata } | { ok: false; reason: string } {
  const metadata = asset.metadata as Record<string, unknown> | undefined;
  if (!metadata || typeof metadata !== "object") {
    return { ok: false, reason: `资产 ${asset.id} 缺少 metadata` };
  }
  const { storageKey, checksum, contentType, size } = metadata;
  if (typeof storageKey !== "string" || storageKey.length === 0) {
    return { ok: false, reason: `资产 ${asset.id} 缺少 metadata.storageKey` };
  }
  if (typeof checksum !== "string" || !/^[0-9a-f]{64}$/.test(checksum)) {
    return { ok: false, reason: `资产 ${asset.id} 的 metadata.checksum 非法` };
  }
  if (typeof contentType !== "string" || contentType.length === 0) {
    return { ok: false, reason: `资产 ${asset.id} 的 metadata.contentType 非法` };
  }
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
    return { ok: false, reason: `资产 ${asset.id} 的 metadata.size 非法` };
  }
  return { ok: true, metadata: { storageKey, checksum, contentType, size } };
}

export type AssetValidationOptions = {
  /** 省略时跳过远端存在性检查（例如离线导入 dry-run 的纯结构校验）。 */
  mediaStorage?: MediaStorage;
  /**
   * 这些资产属于哪张画布。已知时传给媒体存储，让远端画布去它路由到的后端核验；
   * 省略时只看主存储（与旧行为一致）。
   */
  scope?: MediaStorageScope;
  /** 允许的资产类型；默认 image/video/audio 需要媒体对象。 */
  now?: string;
};

/**
 * 校验一个资产列表的全部稳定引用。格式错误（形状/前缀/内嵌哈希）**同步**拒绝；
 * 存在性与 metadata 一致性是异步的（需要访问 COS）。
 *
 * 抛 `CanvasStorageError`（`ASSET_REFERENCE_INVALID`），不返回部分结果。
 */
export async function validateAssetReferences(
  assets: readonly StoredAsset[],
  options: AssetValidationOptions = {}
): Promise<void> {
  for (const asset of assets) {
    if (!assetNeedsMediaObject(asset)) continue;
    const read = readStableAssetMetadata(asset);
    if (!read.ok) {
      throw new CanvasStorageError("ASSET_REFERENCE_INVALID", read.reason, { assetId: asset.id });
    }
    const { storageKey, checksum, contentType, size } = read.metadata;

    if (!isControlledStorageKey(storageKey)) {
      throw new CanvasStorageError(
        "ASSET_REFERENCE_INVALID",
        `资产 ${asset.id} 的 storageKey 不在受控内容寻址前缀内`,
        { assetId: asset.id }
      );
    }
    const embedded = storageKeyChecksum(storageKey);
    if (embedded !== checksum) {
      throw new CanvasStorageError(
        "ASSET_REFERENCE_INVALID",
        `资产 ${asset.id} 的 checksum 与 storageKey 内嵌哈希不一致`,
        { assetId: asset.id }
      );
    }

    const mediaStorage = options.mediaStorage;
    if (!mediaStorage) continue;

    const exists = await mediaStorage.exists(storageKey, options.scope);
    if (!exists) {
      throw new CanvasStorageError(
        "ASSET_REFERENCE_INVALID",
        `资产 ${asset.id} 引用的 COS 对象不存在`,
        { assetId: asset.id, storageKey }
      );
    }

    if (typeof mediaStorage.stat === "function") {
      const stat = await mediaStorage.stat(storageKey, options.scope);
      if (stat.size !== size) {
        throw new CanvasStorageError(
          "ASSET_REFERENCE_INVALID",
          `资产 ${asset.id} 的 size 与 COS 对象不一致`,
          { assetId: asset.id, storageKey, declaredSize: size, actualSize: stat.size }
        );
      }
      if (stat.contentType && stat.contentType !== contentType) {
        throw new CanvasStorageError(
          "ASSET_REFERENCE_INVALID",
          `资产 ${asset.id} 的 contentType 与 COS 对象不一致`,
          { assetId: asset.id, storageKey, declaredType: contentType, actualType: stat.contentType }
        );
      }
    }
  }
}

/**
 * 只校验**新增或更新**的资产，避免每次提交都重新访问全部历史资产的 COS 对象。
 * 用于应用服务的命令提交热路径。
 */
export function collectMutatedAssets(
  previous: readonly StoredAsset[],
  next: readonly StoredAsset[]
): StoredAsset[] {
  const before = new Map(previous.map((asset) => [asset.id, asset]));
  const mutated: StoredAsset[] = [];
  for (const asset of next) {
    const prior = before.get(asset.id);
    if (!prior || JSON.stringify(prior.metadata ?? null) !== JSON.stringify(asset.metadata ?? null)) {
      mutated.push(asset);
    }
  }
  return mutated;
}
