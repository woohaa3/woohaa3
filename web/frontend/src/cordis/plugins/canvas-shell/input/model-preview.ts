import type { InteractionCore } from "../interaction-core.js";
import type { HitTarget } from "../hit-test.js";
import { modelPreviewStore } from "../../../services/model-preview-store.js";
import { clampPitch, isFilmSetObjectModelNode, normalizeYaw } from "@woohaa3/contracts";
import { clampPreviewDistanceScale } from "../model-preview-focus.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../../services/canvas-state/index.js";

/**
 * 卡片上的模型交互开关（2026-11-04 起关闭）。
 *
 * 卡片里的模型只是缩略图：拖转会被误当成移动卡片，滚轮缩放会让模型在卡片里变形
 * （表现为模型被拉近拉远、看不出原本比例）。要看模型请选中卡片后点横条上的「查看 3D」，
 * 全屏预览里旋转/缩放/平移都还在。
 *
 * 保留代码与手势机制而不是删除：`model-preview` 手势、命中类型与聚焦工作区共用同一套投影，
 * 拆掉会牵连命中测试与帧调度。改回 `true` 即恢复卡片内交互。
 */
const CARD_MODEL_INTERACTION = false;

export function modelPreviewPointerDown(
  core: InteractionCore,
  event: PointerEvent,
  hit: HitTarget | null,
): boolean {
  if (!CARD_MODEL_INTERACTION) return false;
  if (
    hit?.kind !== "model-preview" ||
    !core.state.selected.includes(hit.nodeId) ||
    event.shiftKey ||
    ![0, 2].includes(event.button)
  )
    return false;
  // Left-dragging an embedded card moves its container, even over the model preview.
  // Right-drag orbit and the standalone model card's preview controls stay available.
  if (event.button === 0) {
    const canvas = workingCanvasOf(woohaa3CanvasStore.getState());
    const node = canvas?.document.nodes.find(node => node.id === hit.nodeId);
    if (isFilmSetObjectModelNode(node, canvas?.nodeData[hit.nodeId])) return false;
  }
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
  // 卡片内滚轮缩放已关闭（见 `CARD_MODEL_INTERACTION`）：滚轮交回画布做视口缩放。
  if (!CARD_MODEL_INTERACTION) return false;
  // Only selected previews can consume wheel input. Avoid an exact renderer
  // query (a synchronous native IPC round trip on desktop) when none can win.
  if (core.state.selected.length === 0) return false;
  const world = core.pointerWorld(event);
  // 只排除不可能命中的输入；遮挡、控件优先级和最终命中仍由 Rust 判断。
  const possible = core.state.selected.some(id => {
    const node = core.renderedNode?.(id);
    if (node === undefined) return true;
    if (node === null) return false;
    return !!node.modelPreview && !node.compositeAsset
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
