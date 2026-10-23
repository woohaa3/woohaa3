/**
 * 拍摄镜头预览卡片与归属线的派生呈现
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，design D5/D8）。
 *
 * 纯函数：从片场 nodeData + 预览节点归属派生**只读**卡片呈现（标题、类型、画幅、时长、
 * 状态）与归属线端点（卡片左侧中点）。这些字段不写回 ServerCanvas / Y.Doc，也不是第二份
 * 权威数据；卡片与线都只在总览绘制，focus 按既有隔离隐藏。
 *
 * 起点世界相机姿态 → 画布 2D 的投影由调用方按当前观察相机完成（活动动态镜头用同一 T 的
 * 采样相机）；本模块只提供共享几何事实（卡片接口中点）与卡片投影，避免逐帧跨桥查询锚点。
 */
import type { FilmSetNodeData } from "../canvas-node-model.js";
import {
  SHOT_PREVIEW_HEADER_HEIGHT,
  decodeShotPreviewData,
  shotPreviewContentHeight,
  shotPreviewNodeId,
  shotPreviewTargetsForFilmSet
} from "../film-set-shot-preview.js";
import type { FilmSetShotPreviewData } from "../film-set-shot-preview.js";
import type { BevyShotPreviewCardState, BevyShotPreviewLink, BevyShotPreviewPresentation } from "./wire-scene.js";

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

/**
 * 由所属源镜头 + 本地播放状态派生预览卡片呈现（纯投影）。
 *
 * `previewData` 是预览节点自身的归属数据，`filmSetData` 是所属片场的 nodeData（提供 name/
 * kind/aspect/duration 的来源镜头投影）。缺失/非法归属或源镜头已不存在时返回 null
 * （调用方不绘制内容，但保留节点与归属保护）。
 * `progress`/`playing` 只在动态活动预览时由调用方传入，不进入 canonical。
 */
export function shotPreviewCardPresentation(input: {
  filmSetNodeId: string;
  previewData: FilmSetShotPreviewData | unknown;
  filmSetData: FilmSetNodeData | undefined;
  /** 本地播放进度 0..1；仅动态活动预览携带。 */
  progress?: number;
  playing?: boolean;
  state?: BevyShotPreviewCardState;
  diagnostic?: string;
}): BevyShotPreviewPresentation | null {
  const decoded = decodeShotPreviewData(input.previewData);
  if (!decoded.ok) return null;
  if (!input.filmSetData) return null;
  const ownership = decoded.value.shotPreview;
  const target = shotPreviewTargetsForFilmSet(input.filmSetNodeId, input.filmSetData as FilmSetNodeData)
    .find((entry) => entry.clipId === ownership.clipId);
  if (!target) return null;
  const progress = typeof input.progress === "number" && Number.isFinite(input.progress)
    ? Math.min(1, Math.max(0, input.progress))
    : undefined;
  return {
    filmSetNodeId: input.filmSetNodeId,
    clipId: ownership.clipId,
    kind: target.kind,
    name: target.name,
    aspect: target.aspect,
    duration: target.timeline.duration,
    coverCamera: target.coverCamera,
    ...(target.backdrop ? { backdrop: target.backdrop } : {}),
    state: input.state ?? "ready",
    ...(target.kind === "dynamic" && progress !== undefined ? { progress } : {}),
    ...(target.kind === "dynamic" && input.playing !== undefined ? { playing: input.playing } : {}),
    ...(input.diagnostic ? { diagnostic: input.diagnostic } : {})
  };
}

/**
 * 归属线稳定身份：`link:` + owner + clip。位置/缩放变化不改变身份，便于渲染层增量更新。
 */
export function shotPreviewLinkId(ownerNodeId: string, clipId: string): string {
  return `link:${ownerNodeId}:${clipId}`;
}

/**
 * 由源片场镜头集合 + 预览节点几何派生归属线（纯函数）。
 *
 * 预览卡片 id 用共享稳定身份派生；`cameraProjection` 把镜头当前相机世界姿态映射为画布 2D
 * 起点，缺失投影的镜头跳过（不伪造起点）。终点复用 `shotPreviewCardAttachment`，与卡片
 * 命中几何一致。
 */
export function shotPreviewLinksForFilmSet(input: {
  filmSetNodeId: string;
  data: FilmSetNodeData | undefined;
  previewNodeById: (nodeId: string) => { x: number; y: number; width: number; height: number } | undefined;
  cameraProjection: (clipId: string) => { x: number; y: number } | null;
}): BevyShotPreviewLink[] {
  if (!input.data) return [];
  const links: BevyShotPreviewLink[] = [];
  for (const target of shotPreviewTargetsForFilmSet(input.filmSetNodeId, input.data)) {
    const previewNodeId = shotPreviewNodeId(input.filmSetNodeId, target.clipId);
    if (!input.previewNodeById(previewNodeId)) continue;
    const start = input.cameraProjection(target.clipId);
    if (!start) continue;
    links.push({
      id: shotPreviewLinkId(input.filmSetNodeId, target.clipId),
      ownerNodeId: input.filmSetNodeId,
      previewNodeId,
      clipId: target.clipId,
      start: { x: start.x, y: start.y }
    });
  }
  return links;
}
