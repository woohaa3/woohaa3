/**
 * 转换结果的空位布局（change: 2026-10-13-add-node-to-film-set-shortcut，任务 1.3 / design D4）。
 *
 * 片场放在源节点旁的空位；优先右侧，然后左、下、上，保持与已有节点不重叠。纯函数、只读
 * 世界几何，不写画布；调用方在权威事务内用它决定 `node.add` 的 `position`。
 */
import type { ServerCanvas } from "../domain/types.js";
import { nodeWorldRect, type Rect } from "../geometry.js";
import { filmSetNodeSize } from "../canvas-node-model.js";
import { groupBottomPadding, groupPadding } from "../domain/core/group-geometry.js";
import { DEFAULT_NODE_DIMS } from "../domain/core/node-factory.js";

/** 片场与相邻节点之间的最小间距（世界单位）。 */
const PLACE_GAP = 32;

function rectsOverlap(a: Rect, b: Rect, gap: number): boolean {
  return a.x < b.x + b.width + gap
    && a.x + a.width + gap > b.x
    && a.y < b.y + b.height + gap
    && a.y + a.height + gap > b.y;
}

/**
 * 规划新片场的画布位置：放在源节点旁的第一处空位，避免与现有节点重叠。
 *
 * - 源节点不存在时返回 `null`（调用方按失败处理）；
 * - 四个候选方向都冲突时回退到右侧（允许重叠，保证结果仍在源节点旁）。
 */
export function planFilmSetConversionPlacement(
  canvas: ServerCanvas,
  sourceNodeId: string
): { x: number; y: number } | null {
  const byId = new Map(canvas.document.nodes.map((node) => [node.id, node]));
  const source = byId.get(sourceNodeId);
  if (!source) return null;
  const rect = nodeWorldRect(source, byId);
  const size = filmSetNodeSize();
  const others: Rect[] = [];
  for (const node of canvas.document.nodes) {
    if (node.id === sourceNodeId) continue;
    others.push(nodeWorldRect(node, byId));
  }
  const candidates = [
    { x: rect.x + rect.width + PLACE_GAP, y: rect.y },
    { x: rect.x - size.width - PLACE_GAP, y: rect.y },
    { x: rect.x, y: rect.y + rect.height + PLACE_GAP },
    { x: rect.x, y: rect.y - size.height - PLACE_GAP }
  ];
  for (const position of candidates) {
    const candidate: Rect = { x: position.x, y: position.y, width: size.width, height: size.height };
    if (!others.some((rect2) => rectsOverlap(candidate, rect2, 0))) return position;
  }
  return candidates[0]!;
}

/** 现有节点原地包进片场 group 的布局：group 世界坐标、成员局部坐标与气泡尺寸。 */
export type FilmSetConversionWrapPlan = {
  group: { x: number; y: number };
  member: { x: number; y: number };
  width: number;
  height: number;
};

/**
 * 把来源节点**原地**包进片场 group（3D 转换不再复制卡片）。
 *
 * group 矩形按 `getGroupLayoutSizes` 的最小尺寸规则贴合成员：成员放在左上内边距处，
 * 底部预留 group 页脚（3D 徽标）。因此来源卡片的世界位置不变，外观只多出一个气泡。
 *
 * 源节点不存在、或已经在任意 group 内时返回 `null`：规范文档不支持嵌套 group，调用方按
 * 拒绝处理，绝不把 group 塞进另一个 group。
 */
export function planFilmSetConversionWrap(
  canvas: ServerCanvas,
  sourceNodeId: string
): FilmSetConversionWrapPlan | null {
  const byId = new Map(canvas.document.nodes.map((node) => [node.id, node]));
  const source = byId.get(sourceNodeId);
  if (!source || source.parentId) return null;
  const rect = nodeWorldRect(source, byId);
  return {
    group: { x: rect.x - groupPadding, y: rect.y - groupPadding },
    member: { x: groupPadding, y: groupPadding },
    width: Math.max(DEFAULT_NODE_DIMS.width, rect.width + groupPadding * 2),
    height: Math.max(DEFAULT_NODE_DIMS.height, rect.height + groupPadding + groupBottomPadding)
  };
}

/**
 * 目标片场默认命名：源名称加「· 片场」后缀，避免与源节点同名。
 * 名称超长由片场名称预算在后续校验中拒绝或调用方裁剪；这里只做组合。
 */
export function filmSetConversionTitle(sourceTitle: string): string {
  const base = sourceTitle.trim() || "素材";
  return `${base} · 片场`;
}
