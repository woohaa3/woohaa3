/**
 * 画布层级的地面锚点（change: 2026-10-27-order-canvas-layers-by-ground-anchor，design D1；
 * change: remove-canvas-groups-and-film-set —— 容器已删除，锚点只取节点矩形底边）。
 *
 * 2D 绘制顺序与命中判定共用同一事实：节点可见地面在绝对画布坐标下的底边（画布 y 向下，
 * 值越大越靠前）。锚点只是纯几何，不读取模型资源状态，因此模型异步到达、临时缺失都不会让
 * 前后关系跳变。
 *
 * 同一锚点按节点 id 升序决胜（稳定字符串比较，与 canonical 排序一致），保证确定性与跨端一致。
 */

/** 参与锚点计算的绝对画布矩形（只需要底边两要素）。 */
export type CanvasGroundRect = {
  y: number;
  height: number;
};

/** 地面锚点：节点矩形的底边（`y + height`）。 */
export function canvasGroundAnchor(rect: CanvasGroundRect): number {
  return rect.y + rect.height;
}

/**
 * 绘制/深度顺序：锚点升序（底边在前的先画、在后），同锚点按 id 升序。
 *
 * 只比较锚点与 id，不比较 `zIndex`、创建时间或文档顺序。
 */
export function compareCanvasGroundOrder(
  left: { id: string; anchor: number },
  right: { id: string; anchor: number }
): number {
  if (left.anchor !== right.anchor) return left.anchor < right.anchor ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
