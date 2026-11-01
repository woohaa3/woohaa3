/**
 * 节点「呈现矩形」到屏幕坐标的投影（从 `host.ts` 的同名方法原样移出，行为不变）。
 *
 * 移出原因只是 file-budget：`host.ts` 曾越过 800 物理行上限。这里只做坐标换算：
 * 输入是节点 id 与若干读函数，输出一个 CSS px 矩形，不写任何实例状态。
 */
import type { ScreenRect, ServerCanvas } from "@woohaa3/contracts";
import { getGroupLayoutSizes } from "@woohaa3/contracts";
import { groupBadgePresentationScreenRect } from "./group-badge-screen-rect.js";
import { groupBadgeProjectionOf } from "../canvas-shell/group-badge-projection.js";

export type PresentationScreenRectInputs = {
  nodeId: string;
  /** 卡片自身的屏幕矩形（拖动/缩放预览已经算进去）。 */
  card: ScreenRect | null;
  /** 当前 working canvas（缺失时按 null 处理）。 */
  canvas: ServerCanvas | null;
  /** 视口缩放（合成资产 scope 投影用）。 */
  zoom: number;
  /** 合成资产 scope 查询；`ok: false` 时只有失败原因，没有 `value`。 */
  queryCompositeAssetScopes: () =>
    | { ok: true; value: Array<{ nodeId: string; aabb: readonly number[] }> }
    | { ok: false; reason?: string }
    | null;
  /** 世界坐标转 CSS 客户端坐标。 */
  worldToClient: (point: { x: number; y: number }) => { x: number; y: number } | null;
};

/**
 * 单节点屏幕矩形（CSS px）（change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.1）。
 * 未挂载或节点不存在返回 null。
 */
export function presentationScreenRect(input: PresentationScreenRectInputs): ScreenRect | null {
  const { nodeId, card, canvas, zoom } = input;
  const node = canvas?.document.nodes.find((entry) => entry.id === nodeId);
  // 普通 group 的执行面板跟随外部 3D 徽标，而不是跟随气泡主体。使用当前 screen rect
  // 保留拖动/缩放预览，再把同一份徽标几何投影到屏幕。
  //
  // 基准必须是**渲染矩形**而不是节点自身尺寸：Rust 把徽标画在渲染场景节点矩形的下缘，
  // 而 group 的渲染矩形是成员包围后的布局尺寸（`getGroupLayoutSizes`，可比节点自身高得多）。
  // 用节点尺寸推导会把徽标算高一整段，面板随之压回场景上。
  if (card && node?.type === "group") {
    const data = canvas?.nodeData[nodeId];
    const layout = canvas ? getGroupLayoutSizes(canvas.document.nodes).get(nodeId) ?? null : null;
    return groupBadgePresentationScreenRect({
      card,
      zoom,
      node,
      layout,
      collapsed: data?.groupCollapsed === true,
      projection: groupBadgeProjectionOf(canvas, nodeId)
    }) ?? card;
  }
  const scopes = input.queryCompositeAssetScopes();
  if (!scopes?.ok) return card;
  const scope = scopes.value.find((entry) => entry.nodeId === nodeId);
  if (!scope) return card;
  const [worldLeft, worldTop, width, height] = scope.aabb;
  const start = input.worldToClient({ x: worldLeft, y: worldTop });
  const end = input.worldToClient({ x: worldLeft + width, y: worldTop + height });
  if (!start || !end) return card;
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const right = Math.max(start.x, end.x);
  const bottom = Math.max(start.y, end.y);
  const x = Math.min(card?.left ?? left, left);
  const y = Math.min(card?.top ?? top, top);
  return { left: x, top: y, width: right - x, height: bottom - y };
}
