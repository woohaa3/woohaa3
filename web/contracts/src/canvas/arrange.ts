/**
 * 选区整理规划：六种对齐与两种等距分布
 * （change: 2026-10-09-improve-canvas-workflow，任务 4.3 / design D6）。
 *
 * - 对齐使用选区原世界包围盒作为锚点；
 * - 等距分布按轴上起点、nodeId 稳定排序，固定两端外边界，间距非负；
 * - 画布不再支持分组容器，所有节点都在同一平面直接移动。
 *
 * 纯函数：只读取传入画布，返回 `node.update` 命令批次（供受保护 edit.apply 捕获）。
 */
import { computeAlignment, computeDistribution, nodeWorldRect, type AlignmentKind, type DistributionKind } from "./geometry.js";
import type { CanvasCommand } from "./commands.js";
import type { ServerCanvas, Woohaa3CanvasSerializedNode } from "./domain/index.js";

export type ArrangeRequest = {
  kind: AlignmentKind | DistributionKind;
};

export type ArrangeResult =
  | { ok: true; commands: CanvasCommand[] }
  | { ok: false; reason: string };

const ALIGN_KINDS: readonly AlignmentKind[] = ["left", "right", "h-center", "top", "bottom", "v-center"];
const DISTRIBUTE_KINDS: readonly DistributionKind[] = ["horizontal", "vertical"];

function isAlignment(kind: string): kind is AlignmentKind {
  return (ALIGN_KINDS as readonly string[]).includes(kind);
}

/**
 * 规划一次整理动作。`selectedNodeIds` 是当前选区。
 *
 * 返回整批 `node.update` 命令；无净变化返回空数组（调用方据此不入栈）。
 */
export function planArrangeNodes(
  canvas: ServerCanvas,
  selectedNodeIds: readonly string[],
  request: ArrangeRequest
): ArrangeResult {
  const byId = new Map(canvas.document.nodes.map((node) => [node.id, node]));
  const selected = selectedNodeIds.map((id) => byId.get(id)).filter((node): node is Woohaa3CanvasSerializedNode => !!node);

  if (![...ALIGN_KINDS, ...DISTRIBUTE_KINDS].includes(request.kind)) {
    return { ok: false, reason: "不支持的整理方式" };
  }
  if (selected.length !== selectedNodeIds.length) {
    return { ok: false, reason: "部分选中作品已不存在，请刷新后重试" };
  }

  const rects = selected.map((node) => ({ id: node.id, rect: nodeWorldRect(node, byId) }));
  const targetWorld = isAlignment(request.kind)
    ? computeAlignment(rects, request.kind)
    : computeDistribution(rects, request.kind);
  if (!targetWorld.ok) return { ok: false, reason: targetWorld.reason };

  const commands: CanvasCommand[] = [];
  for (const node of selected) {
    const world = targetWorld.positions.get(node.id);
    if (!world) continue;
    if (world.x === node.position.x && world.y === node.position.y) continue;
    commands.push({ type: "node.update", nodeId: node.id, position: { x: world.x, y: world.y } });
  }
  return { ok: true, commands };
}
