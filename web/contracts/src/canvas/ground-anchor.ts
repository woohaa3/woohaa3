/**
 * 画布层级的地面锚点（change: 2026-10-27-order-canvas-layers-by-ground-anchor，design D1）。
 *
 * 2D 绘制顺序、3D 观察深度与命中判定共用同一事实：节点**可见地面**在绝对画布坐标下的底边
 * （画布 y 向下，值越大越靠前）。锚点只是纯几何：
 *
 * - 不读取 `has_badge`、徽章绘制矩形或模型资源状态，因此模型异步到达、临时缺失都不会让
 *   前后关系跳变；
 * - 片场/复合资产取地面范围外包框底边（与绘制、命中同一 `scopeGround` 公式）；片场的节点
 *   矩形只是内容适配框，用它的底边会把「可见地面更靠下」的小片场排到后面；
 * - 组用**呈现矩形**（收起后底边固定）、其他节点用节点矩形；成员使用绝对坐标；
 * - 徽章的 6 单位下探与阴影不进入锚点，否则同尺寸组会因是否带模型而换序。
 *
 * 同一锚点按节点 id 升序决胜（稳定字符串比较，与 canonical 排序一致），保证确定性与跨端
 * 一致；Bevy 侧顶层 `depth_order` 使用同一锚点与 id 决胜顺序，并且只对可见外包框相交的
 * 3D 根做整对象前后分离（同一根内部仍逐像素），2D 顺序与它保持一致。
 */
import {
  compositeAssetScopeGround,
  type ScopeGround,
} from "./render-scene/composite-asset-scope.js";

/** 参与锚点计算的绝对画布矩形（只需要底边两要素与可选地面范围）。 */
export type CanvasGroundRect = {
  y: number;
  height: number;
  compositeAsset?: { scopeGround?: ScopeGround } | undefined;
};

/** 地面锚点：可见地面外包框的底边（`y + height`）。 */
export function canvasGroundAnchor(rect: CanvasGroundRect): number {
  const ground = rect.compositeAsset?.scopeGround;
  if (ground) {
    const { aabb } = compositeAssetScopeGround(ground);
    return aabb.y + aabb.height;
  }
  return rect.y + rect.height;
}

/**
 * 容器绘制/深度顺序：锚点升序（底边在前的先画、在后），同锚点按 id 升序。
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
