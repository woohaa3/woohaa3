/**
 * 组徽标投影查询（change: 2026-10-30-remove-group-badge-scaling）。
 *
 * 徽标范围由组模型在当前呈现下的投影包围盒派生。投影只依赖已 prepared 的模型资源
 * （AABB + extent）与组的展示 placement，因此文档级消费者（小地图、导航、驻留、拖放索引）
 * 可以复用浏览器同一份 prepared 资源，而不必等待渲染帧。
 *
 * 普通组与片场组使用同一画布共享模型单位：徽标按模型自身宽高呈现，不读组框宽度，也不按组宽
 * 取景（change: 2026-10-31-render-film-set-badge-at-model-units）。片场组只额外把模型顶边锚在
 * 组框下方，避免场景盖住成员卡片。资源未就绪或几何非法时返回 `null`：调用方回退到结构矩形或
 * 隐藏，不得用倍率/固定框占位。
 */
import {
  groupAppearanceModel,
  groupModelProjection,
  readFilmSetGroupMarker,
  type FilmSetNodeData,
  type GroupBadgeProjection,
  type PreparedModelResource,
  type ServerCanvas
} from "@woohaa3/contracts";
import { modelSceneStore } from "../model-scene/model-scene-store.js";

function projectionOf(
  canvas: ServerCanvas | null | undefined,
  nodeId: string,
  resource: PreparedModelResource
): GroupBadgeProjection | null {
  const data = canvas?.nodeData[nodeId] as { groupAppearance?: unknown } | undefined;
  const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
  const filmSet = node?.type === "group" && readFilmSetGroupMarker(data as FilmSetNodeData | undefined) !== null;
  const placement = groupAppearanceModel(data).placement;
  return groupModelProjection({
    sceneVersion: resource.sceneVersion,
    ops: [],
    extent: resource.extent,
    aabb: resource.aabb,
    placement,
    badgeTopAnchored: filmSet
  });
}

/** 单个组节点的徽标投影；无 prepared 资源时返回 `null`。 */
export function groupBadgeProjectionOf(
  canvas: ServerCanvas | null | undefined,
  nodeId: string
): GroupBadgeProjection | null {
  const resource = modelSceneStore.get(nodeId);
  if (!resource) return null;
  return projectionOf(canvas, nodeId, resource);
}

/** 一次为多个组节点解析投影；只包含资源就绪且几何合法的节点。 */
export function groupBadgeProjectionsOf(
  canvas: ServerCanvas | null | undefined,
  nodeIds: Iterable<string>
): Map<string, GroupBadgeProjection> {
  const result = new Map<string, GroupBadgeProjection>();
  if (!canvas) return result;
  for (const id of nodeIds) {
    const resource = modelSceneStore.get(id);
    if (!resource) continue;
    const projection = projectionOf(canvas, id, resource);
    if (projection) result.set(id, projection);
  }
  return result;
}

/** 画布中所有组节点的徽标投影（文档级消费者共用同一口径）。 */
export function groupBadgeProjectionsForCanvas(
  canvas: ServerCanvas | null | undefined
): Map<string, GroupBadgeProjection> {
  if (!canvas) return new Map();
  return groupBadgeProjectionsOf(
    canvas,
    canvas.document.nodes.filter((node) => node.type === "group").map((node) => node.id)
  );
}
