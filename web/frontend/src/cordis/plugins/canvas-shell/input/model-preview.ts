import type { InteractionCore } from "../interaction-core.js";
import type { HitTarget } from "../hit-test.js";
import { modelPreviewStore } from "../../../services/model-preview-store.js";
import { clampPitch, normalizeYaw } from "@woohaa3/contracts";
import { clampPreviewDistanceScale } from "../model-preview-focus.js";

export function modelPreviewPointerDown(
  core: InteractionCore,
  event: PointerEvent,
  hit: HitTarget | null,
): boolean {
  if (
    hit?.kind !== "model-preview" ||
    !core.state.selected.includes(hit.nodeId) ||
    event.shiftKey ||
    ![0, 2].includes(event.button)
  )
    return false;
  core.clearHover();
  event.preventDefault();
  event.stopPropagation();
  core.state.gesture = {
    kind: "model-preview",
    pointerId: event.pointerId,
    nodeId: hit.nodeId,
    last: { x: event.clientX, y: event.clientY },
  };
  core.canvas.setPointerCapture?.(event.pointerId);
  return true;
}

export function modelPreviewPointerMove(
  core: InteractionCore,
  event: PointerEvent,
): boolean {
  const gesture = core.state.gesture;
  if (gesture.kind !== "model-preview") return false;
  if (gesture.pointerId !== event.pointerId) return true;
  const view = modelPreviewStore.get(gesture.nodeId);
  const dx = event.clientX - gesture.last.x,
    dy = event.clientY - gesture.last.y;
  gesture.last = { x: event.clientX, y: event.clientY };
  if (core.state.selected.includes(gesture.nodeId))
    modelPreviewStore.set(gesture.nodeId, {
      azimuth: normalizeYaw(view.azimuth - dx * 0.01),
      elevation: clampPitch(view.elevation + dy * 0.01),
    });
  event.preventDefault();
  event.stopPropagation();
  core.schedule();
  return true;
}

export function modelPreviewWheel(
  core: InteractionCore,
  event: WheelEvent,
): boolean {
  // Only selected previews can consume wheel input. Avoid an exact renderer
  // query (a synchronous native IPC round trip on desktop) when none can win.
  if (core.state.selected.length === 0) return false;
  const world = core.pointerWorld(event);
  // 只排除不可能命中的输入；遮挡、控件优先级和最终命中仍由 Rust 判断。
  const possible = core.state.selected.some(id => {
    const node = core.renderedNode?.(id);
    if (node === undefined) return true;
    if (node === null) return false;
    return !!node.modelPreview
      && world.x >= node.x && world.x <= node.x + node.width
      && world.y >= node.y && world.y <= node.y + node.height;
  });
  if (!possible) return false;
  const hit = core.queryPoint(
    world,
    core.activeViewport().zoom,
  );
  if (
    !hit.ok ||
    hit.value?.kind !== "model-preview" ||
    !core.state.selected.includes(hit.value.nodeId)
  )
    return false;
  event.preventDefault();
  event.stopPropagation();
  const id = hit.value.nodeId,
    view = modelPreviewStore.get(id);
  modelPreviewStore.set(id, {
    distanceScale: clampPreviewDistanceScale(
      id,
      view.distanceScale *
        Math.exp(Math.max(-100, Math.min(100, event.deltaY)) * 0.005),
      core.options.getModelFocusTargets?.() ?? [],
    ),
    azimuth: normalizeYaw(view.azimuth - event.deltaX * 0.003),
  });
  core.schedule();
  return true;
}
