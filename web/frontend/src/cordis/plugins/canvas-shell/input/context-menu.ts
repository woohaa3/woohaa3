import type { InteractionCore } from "../interaction-core.js";

/** WebKit may emit contextmenu without delivering the captured secondary up. */
export function createContextMenuFallback(core: InteractionCore, release: (event: PointerEvent) => void) {
  let finishedAt = -Infinity;
  const now = () => performance.now();
  return {
    begin: () => { finishedAt = -Infinity; },
    end: (event: PointerEvent) => { if (event.button === 2) finishedAt = now(); },
    cancel: () => { finishedAt = now(); },
    handle: (event: MouseEvent) => {
      event.preventDefault();
      if (core.model.active || core.modalActive() || core.options.isVideoFocused?.()) return;
      const gesture = core.state.gesture;
      if (gesture.kind === "right-press") {
        release({ pointerId: gesture.pointerId, button: 2, clientX: event.clientX, clientY: event.clientY,
          preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation() } as PointerEvent);
      } else if (gesture.kind === "none" && now() - finishedAt > 250) {
        // Context-menu-only events (including WebKit control-click) still query
        // this exact point; a previous hover can never stand in for the hit.
        const world = core.pointerWorld(event);
        const hit = core.queryPoint(world, core.activeViewport().zoom, core.state.hoveredEdgeId);
        if (!hit.ok) return;
        const nodeId = hit.value && "nodeId" in hit.value ? hit.value.nodeId : null;
        if (nodeId && !core.state.selected.includes(nodeId)) core.setSelection([nodeId]);
        core.options.onContextMenu?.({ screen: { x: event.clientX, y: event.clientY }, world,
          node: nodeId ? { nodeId } : null });
      }
      finishedAt = now();
    }
  };
}
