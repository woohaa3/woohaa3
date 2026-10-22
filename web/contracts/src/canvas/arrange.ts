/**
 * 选区整理规划：同直接父级的六种对齐与两种等距分布
 * （change: 2026-10-09-improve-canvas-workflow，任务 4.3 / design D6）。
 *
 * - 对齐使用选区原世界包围盒作为锚点；
 * - 等距分布按轴上起点、nodeId 稳定排序，固定两端外边界，间距非负；
 * - 组内选中的同层成员移动后按既有规则原子 refit 父组，并补偿其它成员局部坐标，
 *   保持未选成员世界位置不变；
 * - 全部对象必须共享同一直接父级且可移动；非法混选或空间不足整次禁用。
 *
 * 纯函数：只读取传入画布，返回 `node.update` 命令批次（供受保护 edit.apply 捕获）。
 */
import { computeAlignment, computeDistribution, nodeWorldRect, type AlignmentKind, type DistributionKind } from "./geometry.js";
import { refitWoohaa3CanvasGroups, getWoohaa3CanvasNodeAbsolutePosition } from "./domain/core/group-ops.js";
import type { CanvasCommand } from "./commands.js";
import type { ServerCanvas, Woohaa3CanvasNode, Woohaa3CanvasSerializedNode } from "./domain/index.js";

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
 * 规划一次整理动作。`selectedNodeIds` 是当前选区（可为 group 成员）。
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

  // 同一直接父级：parentId 全部一致（含都为顶层）。
  const parents = new Set(selected.map((node) => node.parentId ?? null));
  if (parents.size > 1) {
    return { ok: false, reason: "所选作品不在同一层级，请选择同一分组内的作品" };
  }
  // 父与后代混选：选中集合包含明确的父子对。
  const selectedSet = new Set(selected.map((node) => node.id));
  for (const node of selected) {
    if (node.parentId && selectedSet.has(node.parentId)) {
      return { ok: false, reason: "不能同时选择分组与其成员，请只选择同一层的作品" };
    }
  }

  const rects = selected.map((node) => ({ id: node.id, rect: nodeWorldRect(node, byId) }));
  const targetWorld = isAlignment(request.kind)
    ? computeAlignment(rects, request.kind)
    : computeDistribution(rects, request.kind);
  if (!targetWorld.ok) return { ok: false, reason: targetWorld.reason };

  // 世界 → 父级局部坐标：减去直接父级的绝对偏移（全部选中项共享同一父级）。
  const parentId = selected[0]!.parentId;
  const runtimeById = new Map<string, Woohaa3CanvasNode>(
    canvas.document.nodes.map((node) => [node.id, {
      id: node.id,
      type: node.type,
      position: { ...node.position },
      width: node.width,
      height: node.height,
      parentId: node.parentId,
      zIndex: node.zIndex,
      data: {}
    }])
  );
  const parentOffset = parentId
    ? getWoohaa3CanvasNodeAbsolutePosition(runtimeById.get(parentId)!, runtimeById)
    : { x: 0, y: 0 };
  const localPositions = new Map<string, { x: number; y: number }>();
  for (const node of selected) {
    const world = targetWorld.positions.get(node.id);
    if (!world) continue;
    localPositions.set(node.id, { x: world.x - parentOffset.x, y: world.y - parentOffset.y });
  }

  return finalizeArrange(canvas, localPositions, parentId);
}

/**
 * 应用选中移动并 refit 父组；返回实际发生变化的 `node.update` 命令。
 *
 * 用与运行时相同的 group-ops 语义：只把变化合成为一个批次，未选成员世界位置由 refit 补偿。
 */
function finalizeArrange(
  canvas: ServerCanvas,
  localPositions: Map<string, { x: number; y: number }>,
  parentId: string | undefined
): ArrangeResult {
  // 转为运行时节点集合做 group-ops（data 仅为占位，不参与几何）。
  const runtimeNodes: Woohaa3CanvasNode[] = canvas.document.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    position: { ...node.position },
    width: node.width,
    height: node.height,
    parentId: node.parentId,
    zIndex: node.zIndex,
    data: {}
  }));
  const moved = runtimeNodes.map((node) => {
    const next = localPositions.get(node.id);
    return next ? { ...node, position: { ...next } } : node;
  });

  // 组内成员移动后 refit 直属父组（扩大/收缩），补偿未选成员局部坐标以保持世界位置。
  let finalized = moved;
  if (parentId) {
    const parent = runtimeNodes.find((node) => node.id === parentId);
    if (parent && parent.type === "group") {
      const refit = refitWoohaa3CanvasGroups(moved, [parentId]);
      if (refit.changed) finalized = refit.nodes;
    }
  }

  const beforeById = new Map(runtimeNodes.map((node) => [node.id, node]));
  const commands: CanvasCommand[] = [];
  for (const node of finalized) {
    const prev = beforeById.get(node.id)!;
    const positionChanged = node.position.x !== prev.position.x || node.position.y !== prev.position.y;
    const sizeChanged = node.width !== prev.width || node.height !== prev.height;
    if (!positionChanged && !sizeChanged) continue;
    commands.push({
      type: "node.update",
      nodeId: node.id,
      ...(positionChanged ? { position: { x: node.position.x, y: node.position.y } } : {}),
      ...(sizeChanged && node.width !== undefined ? { width: node.width } : {}),
      ...(sizeChanged && node.height !== undefined ? { height: node.height } : {})
    });
  }
  return { ok: true, commands };
}
