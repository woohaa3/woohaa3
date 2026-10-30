/**
 * 组徽标投影查询（change: 2026-10-30-remove-group-badge-scaling）。
 *
 * 徽标范围由组模型在当前呈现下的投影包围盒派生。投影只依赖已 prepared 的模型资源
 * （AABB + extent）与组的展示 placement，因此文档级消费者（小地图、导航、驻留、拖放索引）
 * 可以复用浏览器同一份 prepared 资源，而不必等待渲染帧。
 *
 * 普通组使用共享画布单位；片场组是场景容器，先按组内容宽度取景，并把模型顶边锚在组框下方，
 * 避免整场组合被压成单个卡片的 192px 基准。资源未就绪或几何非法时返回 `null`：调用方回退到
 * 结构矩形或隐藏，不得用倍率/固定框占位。
 */
import {
  filmSetGroupBadgePlacement,
  getGroupLayoutSizes,
  groupAppearanceModel,
  groupModelProjection,
  readFilmSetGroupMarker,
  type FilmSetNodeData,
  type GroupBadgeProjection,
  type PreparedModelResource,
  type ServerCanvas
} from "@woohaa3/contracts";
import { modelSceneStore } from "../model-scene/model-scene-store.js";

type GroupSizes = ReadonlyMap<string, { width: number; height: number }>;

function projectionOf(
  canvas: ServerCanvas | null | undefined,
  nodeId: string,
  resource: PreparedModelResource,
  groupSizes: GroupSizes | undefined
): GroupBadgeProjection | null {
  const data = canvas?.nodeData[nodeId] as { groupAppearance?: unknown } | undefined;
  const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
  const filmSet = node?.type === "group" && readFilmSetGroupMarker(data as FilmSetNodeData | undefined) !== null;
  const width = groupSizes?.get(nodeId)?.width ?? node?.width;
  const placement = groupAppearanceModel(data).placement;
  const input = {
    sceneVersion: resource.sceneVersion,
    ops: [],
    extent: resource.extent,
    aabb: resource.aabb,
    placement
  };
  return groupModelProjection({
    ...input,
    placement: filmSet && width !== undefined
      ? filmSetGroupBadgePlacement(input, width)
      : placement,
    badgeTopAnchored: filmSet
  });
}

/** 单个组节点的徽标投影；无 prepared 资源时返回 `null`。 */
export function groupBadgeProjectionOf(
  canvas: ServerCanvas | null | undefined,
  nodeId: string,
  /** 调用方已算出的组布局尺寸，避免为单个节点重复遍历文档。 */
  layout?: { width: number; height: number } | null
): GroupBadgeProjection | null {
  const resource = modelSceneStore.get(nodeId);
  if (!resource) return null;
  const groupSizes = layout
    ? new Map([[nodeId, layout]])
    : canvas
      ? getGroupLayoutSizes(canvas.document.nodes)
      : undefined;
  return projectionOf(canvas, nodeId, resource, groupSizes);
}

/** 一次为多个组节点解析投影；只包含资源就绪且几何合法的节点。 */
export function groupBadgeProjectionsOf(
  canvas: ServerCanvas | null | undefined,
  nodeIds: Iterable<string>,
  /** 调用方已算出的组布局尺寸，避免热路径重复遍历文档。 */
  groupSizes?: GroupSizes
): Map<string, GroupBadgeProjection> {
  const result = new Map<string, GroupBadgeProjection>();
  if (!canvas) return result;
  const sizes = groupSizes ?? getGroupLayoutSizes(canvas.document.nodes);
  for (const id of nodeIds) {
    const resource = modelSceneStore.get(id);
    if (!resource) continue;
    const projection = projectionOf(canvas, id, resource, sizes);
    if (projection) result.set(id, projection);
  }
  return result;
}

/** 画布中所有组节点的徽标投影（文档级消费者共用同一口径）。 */
export function groupBadgeProjectionsForCanvas(
  canvas: ServerCanvas | null | undefined,
  groupSizes?: GroupSizes
): Map<string, GroupBadgeProjection> {
  if (!canvas) return new Map();
  return groupBadgeProjectionsOf(
    canvas,
    canvas.document.nodes.filter((node) => node.type === "group").map((node) => node.id),
    groupSizes
  );
}
