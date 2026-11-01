import { bevyNodeHistoryStripDot } from "@woohaa3/contracts";
import type { InteractionCore } from "../interaction-core.js";
import type { HitTarget } from "../hit-test.js";

/** 圆点只接受点击；超过点击容差后由现有画布平移手势接管。 */
export function createHistoryClick(core: InteractionCore) {
  const choose = (nodeId: string, event: Pick<PointerEvent, "clientX" | "clientY">) => {
    const bounds = core.renderedNode?.(nodeId);
    const dots = bounds?.historyStrip?.dots ?? [];
    if (!bounds || !dots.length) return null;
    const world = core.pointerWorld(event);
    let closest = 0, distance = Infinity;
    for (let i = 0; i < dots.length; i++) {
      const d = Math.abs(bevyNodeHistoryStripDot(bounds, i, dots.length).x - world.x);
      if (d < distance) { distance = d; closest = i; }
    }
    return dots[closest] ?? null;
  };
  const down = (event: PointerEvent, hit: HitTarget | null) => {
    if (event.button !== 0 || hit?.kind !== "history" || !core.options.onNodeHistorySelect) return false;
    const dot = choose(hit.nodeId, event);
    event.preventDefault();
    if (!dot?.presentationId) return true;
    core.state.gesture = { kind: "history-press", pointerId: event.pointerId, nodeId: hit.nodeId, presentationId: dot.presentationId, startScreen: { x: event.clientX, y: event.clientY } };
    core.canvas.setPointerCapture?.(event.pointerId);
    core.schedule();
    return true;
  };
  const move = (event: PointerEvent) => {
    const gesture = core.state.gesture;
    if (gesture.kind !== "history-press") return false;
    if (gesture.pointerId !== event.pointerId) return true;
    if (Math.hypot(event.clientX - gesture.startScreen.x, event.clientY - gesture.startScreen.y) > 4) {
      core.state.gesture = { kind: "pan", pointerId: gesture.pointerId, last: gesture.startScreen };
      core.schedule();
      return false;
    }
    event.preventDefault(); return true;
  };
  const up = (event: PointerEvent) => {
    const gesture = core.state.gesture;
    if (gesture.kind !== "history-press") return false;
    if (gesture.pointerId !== event.pointerId) return true;
    core.state.gesture = { kind: "none" };
    core.schedule();
    event.preventDefault();
    try { core.canvas.releasePointerCapture?.(event.pointerId); } catch { /* 指针可能已释放。 */ }
    if (Math.hypot(event.clientX - gesture.startScreen.x, event.clientY - gesture.startScreen.y) <= 4
      && !core.modalActive()) {
      const dots = core.renderedNode?.(gesture.nodeId)?.historyStrip?.dots ?? [];
      const dot = dots.find(item => item.presentationId === gesture.presentationId);
      if (!dot) return true;
      // 已完成的非当前版本直接切换；失败/运行中/当前版本仍只做只读查看。
      // 真正的写面由 InlineVersions.activate 调用受控历史 apply 完成，不进入聚焦或面板。
      const applyable = dot.state === "succeeded" && dot.recoverable !== false && !!dot.entryId && !dot.current;
      core.options.onNodeHistorySelect?.({ nodeId: gesture.nodeId, presentationId: gesture.presentationId,
        entryId: dot.entryId, operationId: dot.operationId, viewOnly: !applyable });
    }
    return true;
  };
  return { down, move, up };
}
