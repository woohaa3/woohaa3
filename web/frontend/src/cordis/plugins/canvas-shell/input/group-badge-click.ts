import type { HitTarget } from "../hit-test.js";
import type { InteractionCore } from "../interaction-core.js";
import { woohaa3CanvasStore, workingCanvasOf } from "../../../services/canvas-state/index.js";

const ACTION = "group-toggle-collapse";
const isBadge = (hit: HitTarget | null): hit is Extract<HitTarget, { kind: "node-action" }> =>
  hit?.kind === "node-action" && hit.actionId === ACTION;

/** 徽标只接受同一目标上的短点击；拖动、取消、只读与并发状态变化都不切换。 */
export function createGroupBadgeClick(core: InteractionCore) {
  const down = (event: PointerEvent, hit: HitTarget | null) => {
    if (event.button !== 0 || !isBadge(hit)) return false;
    event.preventDefault();
    if (!core.writable()) return true;
    const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
    if (canvas?.document.nodes.find(node => node.id === hit.nodeId)?.type !== "group") return true;
    core.state.gesture = { kind: "group-badge-press", pointerId: event.pointerId, nodeId: hit.nodeId,
      collapsed: canvas.nodeData[hit.nodeId]?.groupCollapsed === true,
      startScreen: { x: event.clientX, y: event.clientY }, moved: false };
    core.canvas.setPointerCapture?.(event.pointerId);
    return true;
  };
  const move = (event: PointerEvent) => {
    const gesture = core.state.gesture;
    if (gesture.kind !== "group-badge-press") return false;
    if (gesture.pointerId === event.pointerId && Math.hypot(event.clientX - gesture.startScreen.x,
      event.clientY - gesture.startScreen.y) > 4) gesture.moved = true;
    event.preventDefault();
    return true;
  };
  const up = (event: PointerEvent) => {
    const gesture = core.state.gesture;
    if (gesture.kind !== "group-badge-press") return false;
    if (gesture.pointerId !== event.pointerId) return true;
    event.preventDefault();
    try {
      if (gesture.moved || Math.hypot(event.clientX - gesture.startScreen.x, event.clientY - gesture.startScreen.y) > 4
        || !core.writable() || core.modalActive()) return true;
      const hit = core.queryPoint(core.pointerWorld(event), core.activeViewport().zoom);
      if (!hit.ok || !isBadge(hit.value) || hit.value.nodeId !== gesture.nodeId) return true;
      const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
      if (canvas?.document.nodes.find(node => node.id === gesture.nodeId)?.type !== "group") return true;
      const data = canvas.nodeData[gesture.nodeId];
      if ((data?.groupCollapsed === true) !== gesture.collapsed) return true;
      core.setSelection([gesture.nodeId]);
      void Promise.resolve(core.submit([{ type: "nodeData.patch", nodeId: gesture.nodeId,
        value: { groupCollapsed: !gesture.collapsed }, expectedNodeData: { [gesture.nodeId]: data ?? null } }]))
        .then(result => { if (result === "rejected") core.options.onInteractionError?.(new Error("组状态未能保存，请重试")); })
        .catch(error => core.options.onInteractionError?.(error));
    } finally {
      core.state.gesture = { kind: "none" };
      try { core.canvas.releasePointerCapture?.(event.pointerId); } catch { /* 浏览器已释放。 */ }
      core.schedule();
    }
    return true;
  };
  return { down, move, up };
}
