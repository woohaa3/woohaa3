/**
 * 预览卡片与归属线原语投影
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，design D5/D8；
 *  change: 2026-10-28-generic-extension-content-ownership 任务 4.3 通用化）。
 *
 * 纯函数：从 owner nodeData + 卡片归属派生**只读**通用原语（预览卡片、归属线起点/终点）。
 * 这些字段不写回 ServerCanvas / Y.Doc，也不是第二份权威数据。
 *
 * 本模块只产出 `BevyPreviewCardPrimitive` / `BevyOwnershipLinkPrimitive`：渲染层不识别
 * 片场 id、clipId 等业务字段；业务语义若需透传，只能经版本化 `payload`。
 */
import { MODEL_CAMERA_ASPECTS } from "../model-cameras.js";
import type { FilmSetNodeData } from "../canvas-node-model.js";
import {
  SHOT_PREVIEW_HEADER_HEIGHT,
  decodeShotPreviewData,
  shotPreviewContentHeight,
  shotPreviewNodeId,
  shotAspectValue,
  shotPreviewTargetsForFilmSet
} from "../film-set-shot-preview.js";
import type { FilmSetShotPreviewData } from "../film-set-shot-preview.js";
import type {
  BevyOwnershipLinkPrimitive,
  BevyPreviewCardPrimitive,
  BevyPreviewCardState,
  ContentPresentationPrimitives
} from "./wire-primitives.js";
import { readFilmSetGroupMarker } from "../film-set-group.js";
import { managedShotPreviewOwnershipOf, shotPreviewOwnershipOf } from "../film-set-shot-preview.js";
import { isFilmSetNode } from "../film-set-legacy-identity.js";
import type { ServerCanvas } from "../domain/index.js";

/** 预览卡片接口（归属线终点）在卡片几何上的**左侧中点**（画布坐标）。 */
export function shotPreviewCardAttachment(node: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number } {
  return { x: node.x, y: node.y + node.height / 2 };
}

/**
 * 预览卡片内容区矩形（画布坐标）：标题区在上、内容区在下。
 *
 * 内容区完整保留镜头 aspect；命中与绘制共用这一份几何，标题和内容不各算一次。
 */
export function shotPreviewContentRect(node: {
  x: number;
  y: number;
  width: number;
  height: number;
}): { x: number; y: number; width: number; height: number } {
  return {
    x: node.x + 16,
    y: node.y + SHOT_PREVIEW_HEADER_HEIGHT,
    width: Math.max(1, node.width - 32),
    height: Math.max(24, node.height - SHOT_PREVIEW_HEADER_HEIGHT - 16)
  };
}

/** 预览卡片默认内容高度（由镜头 aspect 派生），供布局与命中复用同一常量。 */
export function shotPreviewCardContentHeight(aspect: number): number {
  return shotPreviewContentHeight(aspect);
}

/** 通用预览卡片类型标记（渲染层不自行推导业务文案）。 */
export function previewCardTypeLabel(animated: boolean): string {
  return animated ? "动态镜头" : "静态镜头";
}

/**
 * 由所属源镜头 + 本地播放状态派生通用预览卡片原语（纯投影）。
 *
 * `previewData` 是预览节点自身的归属数据，`ownerData` 是 owner 的 nodeData（提供标题/画幅/
 * 时长/封面相机的来源投影）。缺失/非法归属或源条目已不存在时返回 null（调用方不绘制内容，
 * 但保留节点与归属保护）。
 */
export function shotPreviewCardPresentation(input: {
  /** 卡片节点 canonical id。 */
  nodeId: string;
  /** 归属 owner 节点 id。 */
  ownerNodeId: string;
  previewData: FilmSetShotPreviewData | unknown;
  ownerData: FilmSetNodeData | undefined;
  /** 本地播放进度 0..1；仅动态活动预览携带。 */
  progress?: number;
  playing?: boolean;
  state?: BevyPreviewCardState;
  diagnostic?: string;
}): BevyPreviewCardPrimitive | null {
  const decoded = decodeShotPreviewData(input.previewData);
  if (!decoded.ok) return null;
  if (!input.ownerData) return null;
  const ownership = decoded.value.shotPreview;
  const target = shotPreviewTargetsForFilmSet(input.ownerNodeId, input.ownerData as FilmSetNodeData)
    .find((entry) => entry.clipId === ownership.clipId);
  if (!target) return null;
  const progress = typeof input.progress === "number" && Number.isFinite(input.progress)
    ? Math.min(1, Math.max(0, input.progress))
    : undefined;
  const animated = target.kind === "dynamic";
  return {
    nodeId: input.nodeId,
    ownerNodeId: input.ownerNodeId,
    entityId: ownership.clipId,
    title: target.name,
    typeLabel: previewCardTypeLabel(animated),
    animated,
    aspect: target.aspect,
    duration: target.timeline.duration,
    coverCamera: target.coverCamera,
    ...(target.backdrop ? { backdrop: target.backdrop } : {}),
    state: input.state ?? "ready",
    ...(animated && progress !== undefined ? { progress } : {}),
    ...(animated && input.playing !== undefined ? { playing: input.playing } : {}),
    ...(input.diagnostic ? { diagnostic: input.diagnostic } : {})
  };
}

/**
 * 归属线稳定身份：`link:` + owner + entity。位置/缩放变化不改变身份，便于渲染层增量更新。
 */
export function ownershipLinkId(ownerNodeId: string, entityId: string): string {
  return `link:${ownerNodeId}:${entityId}`;
}

/**
 * 由 owner 条目集合 + 卡片几何派生归属线原语（纯函数）。
 *
 * 卡片 id 用共享稳定身份派生；`cameraProjection` 把条目当前相机世界姿态映射为画布 2D 起点，
 * 缺失投影的条目跳过（不伪造起点）。终点复用 `shotPreviewCardAttachment`，与卡片命中几何一致。
 */
export function ownershipLinksForFilmSet(input: {
  ownerNodeId: string;
  data: FilmSetNodeData | undefined;
  previewNodeById: (nodeId: string) => { x: number; y: number; width: number; height: number } | undefined;
  cameraProjection: (entityId: string) => { x: number; y: number } | null;
}): BevyOwnershipLinkPrimitive[] {
  if (!input.data) return [];
  const links: BevyOwnershipLinkPrimitive[] = [];
  for (const target of shotPreviewTargetsForFilmSet(input.ownerNodeId, input.data)) {
    const previewNodeId = shotPreviewNodeId(input.ownerNodeId, target.clipId);
    if (!input.previewNodeById(previewNodeId)) continue;
    const start = input.cameraProjection(target.clipId);
    if (!start) continue;
    links.push({
      id: ownershipLinkId(input.ownerNodeId, target.clipId),
      ownerNodeId: input.ownerNodeId,
      start: { x: start.x, y: start.y },
      targetNodeIds: [previewNodeId]
    });
  }
  return links;
}

/** Group-owner equivalent used during the composite → group compatibility window. */
export function ownershipLinksForManagedItems(input: {
  ownerNodeId: string;
  ownerData: unknown;
  previewNodeById: (nodeId: string) => { x: number; y: number; width: number; height: number } | undefined;
  cameraProjection: (entityId: string) => { x: number; y: number } | null;
}): BevyOwnershipLinkPrimitive[] {
  const marker = readFilmSetGroupMarker(input.ownerData);
  if (!marker?.clips) return [];
  const links: BevyOwnershipLinkPrimitive[] = [];
  for (const clip of marker.clips) {
    const previewNodeId = shotPreviewNodeId(input.ownerNodeId, clip.id);
    if (!input.previewNodeById(previewNodeId)) continue;
    const start = input.cameraProjection(clip.id);
    if (!start) continue;
    links.push({
      id: ownershipLinkId(input.ownerNodeId, clip.id),
      ownerNodeId: input.ownerNodeId,
      start,
      targetNodeIds: [previewNodeId]
    });
  }
  return links;
}

/** Read-only presentation for a group-owned item during the migration window. */
export function shotPreviewCardPresentationForManagedItem(input: {
  nodeId: string;
  ownerNodeId: string;
  ownerData: unknown;
  entityId: string;
  state?: BevyPreviewCardState;
  progress?: number;
  playing?: boolean;
  diagnostic?: string;
}): BevyPreviewCardPrimitive | null {
  const marker = readFilmSetGroupMarker(input.ownerData);
  const clip = marker?.clips?.find(entry => entry.id === input.entityId);
  if (!clip) return null;
  const camera = marker?.cameras?.find(entry => entry.id === clip.cameraId);
  const animated = (clip.duration ?? 0) > 0;
  return {
    nodeId: input.nodeId,
    ownerNodeId: input.ownerNodeId,
    entityId: clip.id,
    title: clip.name ?? clip.id,
    typeLabel: previewCardTypeLabel(animated),
    animated,
    aspect: shotAspectValue({ initialCamera: { azimuth: camera?.azimuth ?? 0, elevation: camera?.elevation ?? 0.35, distance: camera?.distance ?? 4, focusOffset: camera?.focusOffset ?? { x: 0, y: 0, z: 0 }, aspect: MODEL_CAMERA_ASPECTS.find(aspect => aspect === camera?.aspect) ?? "16:9" } }),
    duration: clip.duration ?? 0,
    coverCamera: { azimuth: camera?.azimuth ?? 0, elevation: camera?.elevation ?? 0.35, distance: camera?.distance ?? 4, focusOffset: camera ? [camera.focusOffset.x, camera.focusOffset.y, camera.focusOffset.z] : [0, 0, 0] },
    ...(clip.backdrop ? { backdrop: clip.backdrop } : {}),
    state: input.state ?? "ready",
    ...(animated && typeof input.progress === "number" && Number.isFinite(input.progress) ? { progress: Math.min(1, Math.max(0, input.progress)) } : {}),
    ...(animated && input.playing !== undefined ? { playing: input.playing } : {}),
    ...(input.diagnostic ? { diagnostic: input.diagnostic } : {})
  };
}

/** 扩展 adapter 侧的本地呈现态（已由宿主校验；只读）。 */
export type PreviewLocalStateInput = {
  state?: BevyPreviewCardState;
  progress?: number;
  playing?: boolean;
  diagnostic?: string;
};

/** 只接受宿主已声明形状的本地态；非法字段逐项丢弃，不猜测。 */
function previewLocalStateOf(value: unknown): PreviewLocalStateInput {
  if (!value || typeof value !== "object") return {};
  const entry = value as Record<string, unknown>;
  const state = entry.state;
  return {
    ...(state === "preparing" || state === "ready" || state === "stale" || state === "error" ? { state } : {}),
    ...(typeof entry.progress === "number" && Number.isFinite(entry.progress) ? { progress: entry.progress } : {}),
    ...(typeof entry.playing === "boolean" ? { playing: entry.playing } : {}),
    ...(typeof entry.diagnostic === "string" ? { diagnostic: entry.diagnostic } : {})
  };
}

/**
 * 片场扩展的呈现 adapter 主体（change: 2026-10-28-generic-extension-content-ownership 任务 4.3）。
 *
 * 读取片场自己的 nodeData / group marker，投影成通用预览卡片与归属线原语；宿主只负责提供
 * 本地呈现态与相机锚点投影。旧 `composite-asset` 预览与新 owner-managed 媒体节点都走同一出口。
 */
export function filmSetPresentationPrimitives(input: {
  canvas: ServerCanvas;
  localStates?: Readonly<Record<string, unknown>>;
  projectEntityAnchor?: (ownerNodeId: string, entityId: string) => { readonly x: number; readonly y: number } | null;
}): ContentPresentationPrimitives {
  const nodeData = input.canvas.nodeData as Record<string, unknown>;
  const nodeById = new Map(input.canvas.document.nodes.map(node => [node.id, node]));
  const previewCards: BevyPreviewCardPrimitive[] = [];
  for (const node of input.canvas.document.nodes) {
    const data = nodeData[node.id];
    const managed = managedShotPreviewOwnershipOf(data);
    const legacy = managed ? null : shotPreviewOwnershipOf(data);
    const ownership = managed ?? legacy;
    if (!ownership) continue;
    const ownerData = nodeData[ownership.filmSetNodeId] as FilmSetNodeData | undefined;
    const local = previewLocalStateOf(input.localStates?.[node.id]);
    const card = managed
      ? shotPreviewCardPresentationForManagedItem({
        nodeId: node.id,
        ownerNodeId: ownership.filmSetNodeId,
        ownerData,
        entityId: ownership.clipId,
        ...local
      })
      : shotPreviewCardPresentation({
        nodeId: node.id,
        ownerNodeId: ownership.filmSetNodeId,
        previewData: data,
        ownerData,
        ...local
      });
    if (card) previewCards.push(card);
  }

  const ownershipLinks: BevyOwnershipLinkPrimitive[] = [];
  const anchorProjection = input.projectEntityAnchor;
  if (anchorProjection) {
    const previewNodeById = (nodeId: string) => {
      const node = nodeById.get(nodeId);
      return node ? { x: node.position.x, y: node.position.y, width: node.width ?? 0, height: node.height ?? 0 } : undefined;
    };
    for (const node of input.canvas.document.nodes) {
      const data = nodeData[node.id];
      if (isFilmSetNode(node.type, data) && !readFilmSetGroupMarker(data)) {
        ownershipLinks.push(...ownershipLinksForFilmSet({
          ownerNodeId: node.id,
          data: data as FilmSetNodeData | undefined,
          previewNodeById,
          cameraProjection: (entityId) => anchorProjection(node.id, entityId)
        }));
      } else if (node.type === "group" && readFilmSetGroupMarker(data)) {
        ownershipLinks.push(...ownershipLinksForManagedItems({
          ownerNodeId: node.id,
          ownerData: data,
          previewNodeById,
          cameraProjection: (entityId) => anchorProjection(node.id, entityId)
        }));
      }
    }
  }

  return {
    ...(previewCards.length > 0 ? { previewCards } : {}),
    ...(ownershipLinks.length > 0 ? { ownershipLinks } : {})
  };
}
