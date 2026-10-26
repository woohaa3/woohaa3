/**
 * 镜头参考的**内容身份**与录制 profile
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 8.1 / design D9）。
 *
 * 参考按 `(画布, filmSetNodeId, clipId, 视觉内容身份, 录制 profile)` 定位同版本视频资产。视觉
 * 内容身份只包含**会改变画面**的输入：镜头构图、相机运动、时间线时长、关联对象/媒体的内容与
 * 摆放、画幅；并**排除**重命名、项目来源说明、卡片位置、画布缩放与 hover 播放头——因此重命名、
 * 拖动卡片或缩放画布不会改变身份，也就不会触发重新录制。
 *
 * 纯函数、无副作用：浏览器与 Node 用同一算法复现；不 import 任何 DOM/Zustand/Yjs。
 */
import { fnv1a64Hex } from "./content-hash.js";
import { resolveFilmSetClip } from "./film-set-clip-view.js";
import { shotPreviewOwnershipOf } from "./film-set-shot-preview.js";
import { managedNodeRelationOf } from "./managed-node.js";
import type { FilmSetItem } from "./film-set-content.js";
import type { FilmSetNodeData } from "./canvas-node-model.js";
import { shotAspectValue } from "./film-set-shot-preview.js";

/** 镜头参考来源预览的片场/镜头归属。 */
export type ShotReferenceOwnership = { filmSetNodeId: string; clipId: string };

/**
 * 从**来源预览节点的 nodeData** 读取镜头参考归属；非预览节点返回 `null`。
 *
 * 客户端与服务端共用本判据，避免两处归属解析分叉。
 */
export function shotReferenceOwnershipOf(previewNodeData: unknown): ShotReferenceOwnership | null {
  const relation = managedNodeRelationOf(previewNodeData);
  if (relation?.extensionId === "film-set") return { filmSetNodeId: relation.ownerNodeId, clipId: relation.entityId };
  const ownership = shotPreviewOwnershipOf(previewNodeData);
  return ownership ? { filmSetNodeId: ownership.filmSetNodeId, clipId: ownership.clipId } : null;
}

/** 内容身份算法版本；改变身份组成时必须升版本，避免旧缓存被误当同版本复用。 */
// v2：坐标语义隔离——画布节点矩形/zoom 不再影响取景身份，取景完全由场景相机与内容决定
// （change: 2026-10-23-isolate-film-set-camera-space，任务 3.2）。
export const SHOT_REFERENCE_CONTENT_VERSION = 2 as const;

/**
 * 录制 profile：编码参数是身份的一部分，改变即产生新版本、不复用旧缓存。
 *
 * `schemaVersion` 是**身份算法**版本（不是内容契约版本）：1 = 旧浏览器 profile（历史缓存仍可
 * 识别），2 = 场景坐标隔离后的取景语义。已有缓存按各自的版本 key 命中，绝不跨版本复用。
 */
export type ShotReferenceRecordProfile = {
  schemaVersion: ShotReferenceProfileSchemaVersion;
  /** 输出像素宽（正偶数）。 */
  width: number;
  /** 输出像素高（正偶数）。 */
  height: number;
  /** 采样帧率（正有限）。 */
  frameRate: number;
};

export type ShotReferenceProfileSchemaVersion = 1 | typeof SHOT_REFERENCE_CONTENT_VERSION;

/** 默认录制 profile（16:9、30fps；与现有导出能力一致）。 */
export const DEFAULT_SHOT_REFERENCE_RECORD_PROFILE: ShotReferenceRecordProfile = {
  schemaVersion: SHOT_REFERENCE_CONTENT_VERSION,
  width: 1280,
  height: 720,
  frameRate: 30
};

/** profile 的稳定字符串标识（进入身份元组与缓存键）。 */
export function shotReferenceProfileKey(profile: ShotReferenceRecordProfile): string {
  // r2：捕捉相机确认渲染后再回读，不复用旧时序产生的黑屏缓存。
  // r4：场景坐标隔离后取景不再依赖画布节点矩形（change: 2026-10-23-isolate-film-set-camera-space）。
  return `v${profile.schemaVersion}-${profile.width}x${profile.height}@${profile.frameRate}-r4`;
}

/**
 * 关联对象的**视觉**投影：去掉名称与来源说明（两者都不参与内容标识），保留几何、模型内容、
 * 媒体身份与运动/播放。按字段显式构造，保证跨调用键序稳定。
 */
function canonicalItemFields(item: FilmSetItem): Record<string, unknown> {
  const base = {
    id: item.id,
    kind: item.kind,
    localTransform: item.localTransform,
    motion: item.motion ?? null,
    playback: item.playback ?? null
  };
  if (item.kind === "model") {
    return { ...base, model: item.model };
  }
  if (item.kind === "ground") {
    return { ...base, size: item.size, color: item.color ?? null };
  }
  return { ...base, assetId: item.assetId, aspectRatio: item.aspectRatio };
}

/**
 * 单个镜头的视觉内容身份（16 位小写 hex）。
 *
 * 输入是片场完整定义与 `clipId`，内部解析片段视图（items + 该片段 binding 的 motion/playback）；
 * 缺失片段返回 `null`，由调用方明确拒绝，不猜测。
 */
export function shotReferenceContentIdentity(input: {
  animation: FilmSetNodeData;
  clipId: string;
  profile?: ShotReferenceRecordProfile;
}): string | null {
  const view = resolveFilmSetClip(input.animation, input.clipId);
  if (!view) return null;
  const profile = input.profile ?? DEFAULT_SHOT_REFERENCE_RECORD_PROFILE;
  const items = [...view.content.items]
    .map(canonicalItemFields)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const tuple = [
    `film-set-shot-reference-v${SHOT_REFERENCE_CONTENT_VERSION}`,
    shotReferenceProfileKey(profile),
    view.clip.kind,
    view.timeline,
    view.initialCamera,
    view.cameraMotion,
    // 背景属于拍摄镜头身份：改背景必须让该镜头的参考视频失效重录（D6）。
    view.clip.backdrop ?? "theme",
    shotAspectValue(view.clip),
    items
  ];
  return fnv1a64Hex(JSON.stringify(tuple));
}

/**
 * 用**已算好的 profile key** 拼缓存键（任务 8.5 复用）。
 *
 * 与 `shotReferenceCacheKey` 同一格式：调用方若已持有 `shotReferenceProfileKey` 结果，直接走本
 * 函数可避免再次展开 profile 对象，也保证两处键串完全一致。
 */
export function shotReferenceCacheKeyWithProfile(input: {
  canvasId: string;
  filmSetNodeId: string;
  clipId: string;
  contentIdentity: string;
  profileKey: string;
}): string {
  return [
    "shot-reference",
    input.canvasId,
    input.filmSetNodeId,
    input.clipId,
    input.contentIdentity,
    input.profileKey
  ].join(":");
}

/** 缓存定位键：画布 + 片场 + clipId + 内容身份 + 录制 profile。 */
export function shotReferenceCacheKey(input: {
  canvasId: string;
  filmSetNodeId: string;
  clipId: string;
  contentIdentity: string;
  profile?: ShotReferenceRecordProfile;
}): string {
  const profile = input.profile ?? DEFAULT_SHOT_REFERENCE_RECORD_PROFILE;
  return shotReferenceCacheKeyWithProfile({ ...input, profileKey: shotReferenceProfileKey(profile) });
}

/**
 * 资产 `metadata` 中记录镜头版本的字段名与读写（任务 8.5–8.7）。
 *
 * 录制完成后，客户端把真实视频资产登记进画布，并在其 metadata 写入该资产对应的镜头版本；下游
 * 提交前由客户端把资产 id 写入 `inputMapping[].sourceAssetIds`，服务端据此校验归属与版本。
 * 预览节点自身仍不承载 `outputAssetId`。
 */
export const SHOT_REFERENCE_METADATA_KEY = "shotReference" as const;

/** 镜头参考资产绑定的镜头版本。 */
export type ShotReferenceAssetLink = {
  filmSetNodeId: string;
  clipId: string;
  contentIdentity: string;
  profileKey: string;
};

/** 构造资产 metadata 中的镜头版本字段。 */
export function shotReferenceAssetMetadata(link: ShotReferenceAssetLink): Record<string, unknown> {
  return { [SHOT_REFERENCE_METADATA_KEY]: { ...link } };
}

/** 读取资产 metadata 中的镜头版本；缺失或非法返回 `null`。 */
export function readShotReferenceAssetLink(metadata: unknown): ShotReferenceAssetLink | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as Record<string, unknown>)[SHOT_REFERENCE_METADATA_KEY];
  if (!raw || typeof raw !== "object") return null;
  const { filmSetNodeId, clipId, contentIdentity, profileKey } = raw as Record<string, unknown>;
  if (
    typeof filmSetNodeId !== "string" || filmSetNodeId === "" ||
    typeof clipId !== "string" || clipId === "" ||
    typeof contentIdentity !== "string" || contentIdentity === "" ||
    typeof profileKey !== "string" || profileKey === ""
  ) {
    return null;
  }
  return { filmSetNodeId, clipId, contentIdentity, profileKey };
}
