/** Pure-position history path. The input is the committed canonical canvas. */
import type { CanvasCommand } from "./commands.js";
import type { ServerCanvas } from "./domain/index.js";
import { snapGraphPosition } from "./domain/core/serialization.js";
import { diffPlan, type EditPlanResult } from "./edit-plan.js";

const indexes = new WeakMap<ServerCanvas["document"]["nodes"], Map<string, { node: ServerCanvas["document"]["nodes"][number]; order: number }>>();

/** null means unsupported: callers must use the general planner for the batch. */
export function planPositionEdit(canvas: ServerCanvas, commands: readonly CanvasCommand[]): EditPlanResult | null {
  if (!commands.length || commands.some(command => command.type !== "node.update"
    || Object.keys(command).some(key => !["type", "nodeId", "position"].includes(key))
    || !command.position)) return null;
  let index = indexes.get(canvas.document.nodes);
  if (!index) {
    index = new Map(canvas.document.nodes.map((node, order) => [node.id, { node, order }]));
    indexes.set(canvas.document.nodes, index);
  }
  const final = new Map<string, { x: number; y: number }>();
  for (const command of commands) {
    if (command.type !== "node.update" || !command.position) return null;
    if (!index.has(command.nodeId)) return { ok: false, reason: `节点 ${command.nodeId} 不存在` };
    const { x, y } = command.position;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: "节点位置必须为有限数值" };
    // Reducer snaps once on finalize, after the last update of each node.
    final.set(command.nodeId, { x: snapGraphPosition(x), y: snapGraphPosition(y) });
  }
  // Reuse the canonical field/precondition builder on the affected subset.
  // Node data/edges are identical and irrelevant to a pure position batch.
  const nodes = [...final.keys()].sort((a, b) => index!.get(a)!.order - index!.get(b)!.order).map(id => index!.get(id)!.node);
  const before = { ...canvas, document: { ...canvas.document, nodes, edges: [] }, nodeData: {} };
  const after = { ...before, document: { ...before.document, nodes: nodes.map(node => ({ ...node, position: final.get(node.id)! })) } };
  return diffPlan(before, after);
}
