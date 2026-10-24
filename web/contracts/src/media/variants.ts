/**
 * 预览派生物（缩略图/海报）的稳定身份契约
 * （change: 2026-10-23-scale-canvas-media-residency，design D4 / 任务 4.1）。
 *
 * 派生物是**可清理缓存**：不改原资产、不产生 canonical 引用、不进入历史。因此它的身份必须
 * 只由「原内容 + variant + 尺寸档 + 输出格式」决定，**不能**含 nodeId、展示 URL、公开路径
 * 前缀或临时授权参数——否则同一份缩略图会被节点数和授权刷新切成无穷多份。
 *
 * 本模块只做纯字符串派生与校验，无副作用、不读存储，供 Media Service（生成/读取）与前端
 * （选择档位）共用同一口径。
 */

/** 派生物种类。`poster` 用于视频静态图，`thumbnail` 用于图片/模型卡片。 */
export const MEDIA_DERIVATIVE_KINDS = ["thumbnail", "poster"] as const;
export type MediaDerivativeKind = (typeof MEDIA_DERIVATIVE_KINDS)[number];

/** 受支持的长边档位（与 design D3「缩略图尺寸」表一致）。 */
export const THUMBNAIL_VARIANT_EDGES = [128, 256, 512, 1024] as const;
export type ThumbnailVariantEdge = (typeof THUMBNAIL_VARIANT_EDGES)[number];

/** 受支持的输出格式 → 内容类型与扩展名（扩展名参与缓存键）。 */
export const MEDIA_DERIVATIVE_FORMATS = {
  webp: "image/webp",
  jpeg: "image/jpeg",
  png: "image/png"
} as const;
export type MediaDerivativeFormat = keyof typeof MEDIA_DERIVATIVE_FORMATS;

/** 派生物缓存键前缀（不含 `/`，避免与内容寻址键混淆）。 */
export const MEDIA_DERIVATIVE_KEY_PREFIX = "derivatives" as const;

/** 稳定派生身份。 */
export type MediaDerivativeIdentity = {
  readonly sourceKey: string;
  readonly kind: MediaDerivativeKind;
  readonly edge: ThumbnailVariantEdge;
  readonly format: MediaDerivativeFormat;
};

const SOURCE_KEY_PATTERN = /^sha256-([0-9a-f]{64})$/;

/** 只有内容寻址的原资产可以派生；生成结果键与任意自由键一律拒绝。 */
export function isDerivableSourceKey(value: unknown): value is string {
  return typeof value === "string" && SOURCE_KEY_PATTERN.test(value);
}

export function isThumbnailVariantEdge(value: unknown): value is ThumbnailVariantEdge {
  return THUMBNAIL_VARIANT_EDGES.includes(value as ThumbnailVariantEdge);
}

export function isMediaDerivativeKind(value: unknown): value is MediaDerivativeKind {
  return MEDIA_DERIVATIVE_KINDS.includes(value as MediaDerivativeKind);
}

export function isMediaDerivativeFormat(value: unknown): value is MediaDerivativeFormat {
  return Object.hasOwn(MEDIA_DERIVATIVE_FORMATS, value as string);
}

/**
 * 派生物缓存键：`derivatives/<sha256>/<kind>-<edge>.<ext>`。
 *
 * 同内容同档位、跨节点/跨展示 URL 恒等；档次或格式不同就是不同缓存项。
 * 非法身份返回 `null`（调用方必须在访问存储**之前**拒绝，不能拼出任意键）。
 */
export function mediaDerivativeCacheKey(identity: MediaDerivativeIdentity): string | null {
  if (!isDerivableSourceKey(identity.sourceKey)) return null;
  if (!isMediaDerivativeKind(identity.kind)) return null;
  if (!isThumbnailVariantEdge(identity.edge)) return null;
  if (!isMediaDerivativeFormat(identity.format)) return null;
  const checksum = identity.sourceKey.slice("sha256-".length);
  return `${MEDIA_DERIVATIVE_KEY_PREFIX}/${checksum}/${identity.kind}-${identity.edge}.${identity.format}`;
}

/** 反向解析缓存键；非法键返回 `null`，供清理/诊断按身份归类。 */
export function parseMediaDerivativeCacheKey(key: string): MediaDerivativeIdentity | null {
  const match =
    /^derivatives\/([0-9a-f]{64})\/(thumbnail|poster)-(128|256|512|1024)\.(webp|jpeg|png)$/.exec(key);
  if (!match) return null;
  const [, checksum, kind, edge, format] = match;
  return {
    sourceKey: `sha256-${checksum}`,
    kind: kind as MediaDerivativeKind,
    edge: Number(edge) as ThumbnailVariantEdge,
    format: format as MediaDerivativeFormat
  };
}

/**
 * 按物理长边选档：向上取最近受支持档位，超过最大档夹到 1024。
 *
 * 与前端 `selectThumbnailTier` 同一规则；这里是供服务端/测试共用的纯函数版本，避免两侧
 * 各写一套边界（NaN、0、超大值）。
 */
export function thumbnailEdgeFor(physicalEdge: number): ThumbnailVariantEdge {
  if (!Number.isFinite(physicalEdge) || physicalEdge <= 0) return THUMBNAIL_VARIANT_EDGES[0];
  for (const edge of THUMBNAIL_VARIANT_EDGES) if (physicalEdge <= edge) return edge;
  return THUMBNAIL_VARIANT_EDGES[THUMBNAIL_VARIANT_EDGES.length - 1];
}

/** 查询参数 → 派生身份；任一参数非法返回 `undefined`（调用方回退到原图读取）。 */
export function thumbnailDerivativeQuery(input: {
  sourceKey: string;
  edge: unknown;
  format?: unknown;
  kind?: unknown;
}): MediaDerivativeIdentity | undefined {
  if (!isDerivableSourceKey(input.sourceKey)) return undefined;
  const edge = typeof input.edge === "string" ? Number(input.edge) : input.edge;
  if (!isThumbnailVariantEdge(edge)) return undefined;
  const kind = input.kind ?? "thumbnail";
  if (!isMediaDerivativeKind(kind)) return undefined;
  const format = input.format ?? "webp";
  if (!isMediaDerivativeFormat(format)) return undefined;
  return { sourceKey: input.sourceKey, kind, edge, format };
}
