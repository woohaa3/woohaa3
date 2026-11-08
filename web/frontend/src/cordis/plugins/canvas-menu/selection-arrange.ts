import { planArrangeNodes, type ArrangeRequest, type ServerCanvas } from "@woohaa3/contracts";
import type { CanvasContextMenuItem } from "./canvas-context-menu.js";

const kinds: readonly [ArrangeRequest["kind"], string][] = [
  ["left", "左对齐"], ["h-center", "水平居中"], ["right", "右对齐"],
  ["top", "顶对齐"], ["v-center", "垂直居中"], ["bottom", "底对齐"],
  ["horizontal", "水平分布"], ["vertical", "垂直分布"]
];

export function planSelectionArrange(canvas: ServerCanvas, ids: readonly string[], kind: ArrangeRequest["kind"]) {
  if (ids.some(id => {
    const node = canvas.document.nodes.find(node => node.id === id);
    return node?.type === "scene-area" || !!canvas.nodeData[id]?.sharedWorldInstance;
  })) return { ok: false as const, reason: "请选择画布卡片整理，世界对象请在导演区中调整" };
  return planArrangeNodes(canvas, ids, { kind });
}

export function selectionArrangeKind(id: string): ArrangeRequest["kind"] | undefined {
  return kinds.find(([kind]) => id === `arrange:${kind}`)?.[0];
}

export function selectionArrangeItems(canvas: ServerCanvas, ids: readonly string[], writable: boolean): CanvasContextMenuItem[] {
  if (ids.length < 2) return [];
  return kinds.map(([kind, label], index) => {
    const plan = planSelectionArrange(canvas, ids, kind);
    const reason = !writable ? "画布当前只读" : !plan.ok ? plan.reason : !plan.commands.length ? "作品已对齐" : undefined;
    return { id: `arrange:${kind}`, label, disabled: !!reason, ...(reason ? { reason } : {}), ...(index === 0 ? { separatorBefore: true } : {}) };
  });
}
