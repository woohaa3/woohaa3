/**
 * 游戏炼丹炉共享契约：素材规范化、默认描述与可用性
 * （change: 2026-10-10-add-game-furnace-extension，任务 1.1–1.5 / design D4/D7/D8/D10）。
 *
 * 纯函数叶子：不 import 宿主 store、Provider、数据库、DOM 或 Node API。
 */
import type { Woohaa3CanvasJsonObject } from "@woohaa3/contracts";
import { DEFAULT_CATEGORY_BY_KIND, GAME_RESOURCE_KINDS, MAX_BUILD_DEPENDENCIES, MAX_CATEGORY_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_NAME_LENGTH, type GameResource, type GameResourceInput, type GameResourceKind, type GameResourceMetadata, type GameResourcePayload, type GameResourceSource, type GameResourceUsability } from "./types.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  if (value.length > max) return null;
  return value;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isJsonObject(value: unknown): value is Woohaa3CanvasJsonObject {
  return isObject(value);
}

/** 规范化一个素材：补默认分类、限制字符串、丢弃非法可选字段。 */
export function normalizeResource(input: GameResourceInput): GameResource {
  if (!isId(input.resourceId)) throw new Error("素材 ID 非法");
  if (!GAME_RESOURCE_KINDS.includes(input.kind)) throw new Error("素材类别非法");
  const name = boundedString(input.name, MAX_NAME_LENGTH);
  if (name === null || name.trim() === "") throw new Error("素材名称非法");
  const category = boundedString(input.category ?? DEFAULT_CATEGORY_BY_KIND[input.kind], MAX_CATEGORY_LENGTH);
  if (category === null) throw new Error("素材分类超长");
  const description = boundedString(input.description ?? "", MAX_DESCRIPTION_LENGTH);
  if (description === null) throw new Error("素材描述超长");
  const payload = normalizePayload(input.payload);
  const metadata = normalizeMetadata(input.metadata);
  const source = input.source ? normalizeSource(input.source) : undefined;
  return {
    resourceId: input.resourceId,
    kind: input.kind,
    name: name.trim(),
    category: category.trim() || DEFAULT_CATEGORY_BY_KIND[input.kind],
    description,
    ...(source ? { source } : {}),
    payload,
    ...(metadata ? { metadata } : {})
  };
}

function normalizePayload(payload: GameResourcePayload): GameResourcePayload {
  if (!isObject(payload)) throw new Error("素材 payload 非法");
  const kinds = ["asset", "text", "model", "scene", "opaque"] as const;
  if (!kinds.includes(payload.kind as (typeof kinds)[number])) throw new Error("素材 payload.kind 非法");
  const assetIds = Array.isArray(payload.assetIds)
    ? [...new Set(payload.assetIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
    : [];
  if (assetIds.length > MAX_BUILD_DEPENDENCIES) throw new Error("素材资产引用超限");
  const result: GameResourcePayload = { kind: payload.kind, assetIds };
  if (payload.assets !== undefined) {
    if (!Array.isArray(payload.assets) || payload.assets.length > MAX_BUILD_DEPENDENCIES) throw Error("素材依赖非法或超限");
    const seen = new Set<string>();
    result.assets = payload.assets.map((asset) => {
      if (!isObject(asset) || typeof asset.assetId !== "string" || !assetIds.includes(asset.assetId)
        || seen.has(asset.assetId) || typeof asset.storageKey !== "string" || !asset.storageKey
        || typeof asset.mime !== "string" || !asset.mime || asset.mime.length > 200) throw Error("素材依赖引用非法");
      seen.add(asset.assetId);
      return { assetId: asset.assetId, storageKey: asset.storageKey, mime: asset.mime,
        ...(typeof asset.size === "number" && Number.isFinite(asset.size) && asset.size >= 0 ? { size: asset.size } : {}) };
    });
  }
  if (payload.snapshot !== undefined) {
    if (!isJsonObject(payload.snapshot)) throw new Error("素材快照必须是 JSON 对象");
    result.snapshot = structuredClone(payload.snapshot);
  }
  return result;
}

function normalizeMetadata(metadata: GameResourceMetadata | undefined): GameResourceMetadata | undefined {
  if (metadata === undefined) return undefined;
  if (!isObject(metadata)) throw new Error("素材 metadata 非法");
  const out: GameResourceMetadata = {};
  if (typeof metadata.mime === "string" && metadata.mime.length <= 200) out.mime = metadata.mime;
  for (const key of ["size", "width", "height", "duration"] as const) {
    const value = metadata[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = value;
  }
  if (typeof metadata.previewAssetId === "string" && metadata.previewAssetId.length > 0) out.previewAssetId = metadata.previewAssetId;
  if (typeof metadata.storageKey === "string" && metadata.storageKey.length > 0) out.storageKey = metadata.storageKey;
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeSource(source: GameResourceSource): GameResourceSource {
  if (!isObject(source) || !isId(source.nodeId) || typeof source.canvasId !== "string" || typeof source.sourceContentHash !== "string") {
    throw new Error("素材来源说明非法");
  }
  return { canvasId: source.canvasId, nodeId: source.nodeId, sourceContentHash: source.sourceContentHash };
}

/** 默认描述取自确定性元数据；缺失时返回空串（UI 显示「待补充描述」，不猜测语义）。 */
export function defaultResourceDescription(input: {
  kind: GameResourceKind;
  name: string;
  metadata?: GameResourceMetadata;
  hasPreview: boolean;
}): string {
  const parts: string[] = [];
  if (input.metadata?.mime) parts.push(input.metadata.mime);
  if (typeof input.metadata?.size === "number") parts.push(`${input.metadata.size} 字节`);
  if (typeof input.metadata?.width === "number" && typeof input.metadata?.height === "number") {
    parts.push(`${input.metadata.width}×${input.metadata.height}`);
  }
  if (typeof input.metadata?.duration === "number" && input.metadata.duration > 0) {
    parts.push(`${input.metadata.duration.toFixed(1)} 秒`);
  }
  if (!input.hasPreview) parts.push("无自动预览");
  return parts.join(" · ");
}

/**
 * 单素材是否可以成为模型可执行输入：图片仅在 catalog 声明支持且用户授权时才算可直接使用；
 * 未知/无法解析文件与模型/导演场默认作为参考素材（design D8/D10）。这决定 build manifest 的
 * used / reference-only / unused 标记，不假装全部资源都参与了生成。
 */
export function resourceUsage(resource: GameResource): GameResourceUsability {
  switch (resource.kind) {
    case "image":
      return { usage: "reference-only", reason: "需模型声明图片输入；否则以描述/运行时资源参与" };
    case "text":
      return { usage: "used" };
    case "model":
    case "film-set":
    case "container":
      return { usage: "reference-only", reason: "造型/场景/逻辑参考；不直接执行其原格式" };
    case "audio":
    case "video":
      return { usage: "reference-only", reason: "作为运行时资源与用途描述；由游戏在用户手势后播放" };
    default:
      return { usage: "unused", reason: "未知格式，仅保留原件" };
  }
}
