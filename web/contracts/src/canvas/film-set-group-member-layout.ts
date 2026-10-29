/**
 * 片场 group 的成员网格布局
 * （change: 2026-10-28-migrate-film-set-to-groups）。
 *
 * 迁移把片场的对象卡片直接当作 group 成员，但保留了它们在**片场坐标系**里的摆放（原点在片场
 * 中心，常有负偏移），而 group 矩形还是旧卡片的位置和尺寸。结果成员几乎全落在气泡外面：气泡
 * 看着是空的，对象卡片散落在画布另一处，和 3D 徽标里的场景重复出现。
 *
 * 这里给出确定性的网格：成员按文档顺序铺进气泡，group 矩形按 `getGroupLayoutSizes` 的最小尺寸
 * 规则重算（与成员布局同源，徽标继续留在下方页脚），因此渲染出的气泡、徽标、执行面板和归属线
 * 基准重新对齐。成员的画布位置不参与 3D 合成（合成只读 `filmSetGroup` marker 里的镜头/对象变换），
 * 所以重排不会改变场景。
 *
 * 纯函数、JSON-only：只产出新节点与尺寸，不写 Y.Doc、不提交命令。
 */
import type { ServerCanvas, Woohaa3CanvasSerializedNode } from "./domain/index.js";
import { effectiveCanvasNodeSize } from "./node-dimensions.js";
import { groupBottomPadding, groupPadding } from "./domain/core/group-geometry.js";
import { readFilmSetGroupMarker } from "./film-set-group.js";

/** 成员卡片之间的间距（画布单位）。 */
export const FILM_SET_MEMBER_GAP = 24;
/** 网格列数上限：再宽就得横向拖动整个气泡才能看全。 */
export const FILM_SET_MEMBER_MAX_COLUMNS = 4;

type Point = { x: number; y: number };

export type FilmSetMemberGridPlan = {
  /** 成员 id → 气泡内局部坐标。 */
  positions: Map<string, Point>;
  /** 气泡尺寸（含四周留白与徽标页脚）。 */
  width: number;
  height: number;
};

/**
 * 片场 group 成员的目标网格。
 *
 * 列数取成员数与 `FILM_SET_MEMBER_MAX_COLUMNS` 的较小值，单元格按成员里最大的可见尺寸
 * （`effectiveCanvasNodeSize`，兼容紧凑旧卡片）铺开；没有成员时返回 null。
 */
export function planFilmSetMemberGrid(input: {
  nodes: readonly Woohaa3CanvasSerializedNode[];
  groupId: string;
}): FilmSetMemberGridPlan | null {
  const members = input.nodes.filter((node) => node.parentId === input.groupId);
  if (members.length === 0) return null;
  const cell = members.reduce((size, node) => {
    const own = effectiveCanvasNodeSize(node);
    return { width: Math.max(size.width, own.width), height: Math.max(size.height, own.height) };
  }, { width: 0, height: 0 });
  const columns = Math.min(members.length, FILM_SET_MEMBER_MAX_COLUMNS);
  const rows = Math.ceil(members.length / columns);
  const positions = new Map<string, Point>();
  members.forEach((node, index) => {
    positions.set(node.id, {
      x: groupPadding + (index % columns) * (cell.width + FILM_SET_MEMBER_GAP),
      y: groupPadding + Math.floor(index / columns) * (cell.height + FILM_SET_MEMBER_GAP)
    });
  });
  return {
    positions,
    width: columns * cell.width + (columns - 1) * FILM_SET_MEMBER_GAP + groupPadding * 2,
    height: rows * cell.height + (rows - 1) * FILM_SET_MEMBER_GAP + groupPadding + groupBottomPadding
  };
}

function memberOutsideBubble(node: Woohaa3CanvasSerializedNode, bubble: { x: number; y: number; width: number; height: number }): boolean {
  const size = effectiveCanvasNodeSize(node);
  const tolerance = 0.5;
  return node.position.x < bubble.x - tolerance
    || node.position.y < bubble.y - tolerance
    || node.position.x + size.width > bubble.x + bubble.width + tolerance
    || node.position.y + size.height > bubble.y + bubble.height + tolerance;
}

/**
 * 一次性补齐：把自动迁移出来、成员却落在气泡外的片场 group 重排进网格。
 *
 * 只处理带 `filmSetGroup.migration` 的 group（迁移产物），且只在**确实有成员在气泡外侧**时动手；
 * 重排后成员全部在气泡内，条件不再成立，因此重复调用是幂等的，也不会覆盖用户自己整理的布局
 * （手搭的片场 group 没有 migration 标记，完全不动）。
 */
export function ensureFilmSetGroupMemberLayout(canvas: ServerCanvas): {
  canvas: ServerCanvas;
  changed: string[];
} {
  const changed: string[] = [];
  const replacements = new Map<string, Point>();
  const sizes = new Map<string, { width: number; height: number }>();
  for (const group of canvas.document.nodes) {
    if (group.type !== "group") continue;
    const data = canvas.nodeData[group.id] as Record<string, unknown> | undefined;
    const marker = readFilmSetGroupMarker(data);
    if (!marker?.migration) continue;
    const members = canvas.document.nodes.filter((node) => node.parentId === group.id);
    if (members.length === 0) continue;
    const bubble = {
      x: group.position.x,
      y: group.position.y,
      width: group.width ?? 0,
      height: group.height ?? 0
    };
    if (!members.some((node) => memberOutsideBubble(node, bubble))) continue;
    const plan = planFilmSetMemberGrid({ nodes: canvas.document.nodes, groupId: group.id });
    if (!plan) continue;
    for (const [id, position] of plan.positions) replacements.set(id, position);
    sizes.set(group.id, { width: plan.width, height: plan.height });
    changed.push(group.id);
  }
  if (changed.length === 0) return { canvas, changed };
  const nodes = canvas.document.nodes.map((node) => {
    const position = replacements.get(node.id);
    const size = sizes.get(node.id);
    if (!position && !size) return node;
    return {
      ...node,
      ...(position ? { position: { x: position.x, y: position.y } } : {}),
      ...(size ?? {})
    };
  });
  return { canvas: { ...canvas, document: { ...canvas.document, nodes } }, changed };
}
