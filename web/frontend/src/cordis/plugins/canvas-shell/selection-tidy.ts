/**
 * 多选「整理卡片」：把选中的卡片排成整齐的网格，并统一成选区里最大的卡片尺寸。
 *
 * 纯规划：只产生 `node.update` 命令，由调用方经 `canvasEdit.record` 一次提交、一次撤销。
 * 网格左上角取选区包围盒的左上角；顺序沿用画面上的阅读顺序（先上后下、同一行内先左后右），
 * 所以整理不会把卡片的相对次序打乱。组卡片不参与（它的范围由成员决定）。
 */
import type { CanvasCommand, ServerCanvas } from "@woohaa3/contracts";
import { memberSize } from "../world-scopes/group-actions.js";

export const SELECTION_TIDY_GAP = 24;
export const SELECTION_TIDY_MIN_NODES = 2;

export type SelectionTidyPlan =
  | { ok: true; commands: CanvasCommand[]; label: string }
  | { ok: false; reason: string };

type Item = { id: string; x: number; y: number; width: number; height: number };

/** 选区里能被整理的卡片：有位置、不是组。 */
export function tidyableNodeIds(canvas: ServerCanvas | null, nodeIds: readonly string[]): string[] {
  if (!canvas) return [];
  const wanted = new Set(nodeIds);
  return canvas.document.nodes
    .filter(node => wanted.has(node.id) && node.type !== "workflow-group-2d" && !!node.position)
    .map(node => node.id);
}

/** 按阅读顺序排：y 相差不到半个卡片高度算同一行，行内按 x。 */
function readingOrder(items: Item[], rowTolerance: number): Item[] {
  const byY = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: Item[][] = [];
  for (const item of byY) {
    const row = rows[rows.length - 1];
    if (row && item.y - row[0]!.y < rowTolerance) row.push(item);
    else rows.push([item]);
  }
  return rows.flatMap(row => row.sort((a, b) => a.x - b.x));
}

export function planSelectionTidy(canvas: ServerCanvas | null, nodeIds: readonly string[]): SelectionTidyPlan {
  const ids = new Set(tidyableNodeIds(canvas, nodeIds));
  const items: Item[] = (canvas?.document.nodes ?? [])
    .filter(node => ids.has(node.id))
    .map(node => ({ id: node.id, x: node.position!.x, y: node.position!.y, ...memberSize(node) }));
  if (items.length < SELECTION_TIDY_MIN_NODES) return { ok: false, reason: "至少选中两张卡片才能整理" };

  const cellWidth = Math.max(...items.map(item => item.width));
  const cellHeight = Math.max(...items.map(item => item.height));
  const originX = Math.min(...items.map(item => item.x));
  const originY = Math.min(...items.map(item => item.y));
  const columns = Math.ceil(Math.sqrt(items.length));

  const commands: CanvasCommand[] = readingOrder(items, cellHeight / 2).map((item, index) => ({
    type: "node.update",
    nodeId: item.id,
    position: {
      x: Math.round(originX + (index % columns) * (cellWidth + SELECTION_TIDY_GAP)),
      y: Math.round(originY + Math.floor(index / columns) * (cellHeight + SELECTION_TIDY_GAP))
    },
    width: Math.round(cellWidth),
    height: Math.round(cellHeight)
  }));
  return { ok: true, commands, label: "整理卡片" };
}
