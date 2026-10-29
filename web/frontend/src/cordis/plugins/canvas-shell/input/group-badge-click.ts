import type { HitTarget } from "../hit-test.js";
import type { InteractionCore } from "../interaction-core.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../../../services/canvas-state/index.js";
import { sharedCanvasNodeIndex } from "../canvas-node-index.js";

const ACTION = "group-badge-select";
const isBadge = (hit: HitTarget | null): hit is Extract<HitTarget, { kind: "node-action" }> =>
  hit?.kind === "node-action" && hit.actionId === ACTION;

/** 收起组徽标是选择/拖动入口；展开由顶部横条动作完成。 */
export function createGroupBadgeClick(core: InteractionCore) {
  const down = (event: PointerEvent, hit: HitTarget | null) => {
    if (event.button !== 0 || !isBadge(hit)) return false;
    event.preventDefault();
    const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
    if (canvas?.document.nodes.find(node => node.id === hit.nodeId)?.type !== "group") return true;
    const index = sharedCanvasNodeIndex(canvas);
    const origin = index?.absolutePosition(hit.nodeId);
    if (!origin) return true;
    if (event.shiftKey) {
      const selected = core.state.selected;
      core.setSelection(selected.includes(hit.nodeId) ? selected.filter(id => id !== hit.nodeId) : [...selected, hit.nodeId]);
    } else if (!core.state.selected.includes(hit.nodeId)) {
      core.setSelection([hit.nodeId]);
    }
    if (!core.writable()) return true;
    core.state.localPositions = new Map();
    core.state.gesture = { kind: "drag", pointerId: event.pointerId, start: core.pointerWorld(event), origins: new Map([[hit.nodeId, origin]]), moved: false };
    core.canvas.setPointerCapture?.(event.pointerId);
    return true;
  };
  const move = (_event: PointerEvent) => {
    const gesture = core.state.gesture;
    // Let the regular drag family update previews, drop targets and commit commands.
    if (gesture.kind === "drag") return false;
    return false;
  };
  const up = (_event: PointerEvent) => {
    const gesture = core.state.gesture;
    if (gesture.kind === "drag") return false;
    return false;
  };
  return { down, move, up };
}
