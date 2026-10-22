/**
 * Canvas Runtime 的模型编辑手势注入辅助
 * （change: refactor-frontend-file-size；从 `host.ts` 拆出以遵守文件体积守卫）。
 *
 * 只做字段保存与向已挂载 controller 转发；不持有规范状态。
 */
import type { InteractionController, InteractionControllerOptions } from "../canvas-shell/interaction-controller.js";

export type ModelEditorGestureRefs = {
  shot: InteractionControllerOptions["shotGesture"] | null;
  focus: InteractionControllerOptions["focusGesture"] | null;
  shotWheel: InteractionControllerOptions["shotWheel"] | null;
  object: InteractionControllerOptions["filmSetObjectGesture"] | null;
  objectAction: InteractionControllerOptions["filmSetObjectAction"] | null;
};

export function createModelEditorGestureRefs(): ModelEditorGestureRefs {
  return { shot: null, focus: null, shotWheel: null, object: null, objectAction: null };
}

export function applyModelEditorShotGesture(
  refs: ModelEditorGestureRefs,
  controller: InteractionController | null,
  handler: InteractionControllerOptions["shotGesture"] | null
): void {
  refs.shot = handler ?? null;
  controller?.setShotGesture(refs.shot);
}

export function applyModelEditorFocusGesture(
  refs: ModelEditorGestureRefs,
  controller: InteractionController | null,
  handler: InteractionControllerOptions["focusGesture"] | null
): void {
  refs.focus = handler ?? null;
  controller?.setFocusGesture(refs.focus);
}

export function applyShotWheel(
  refs: ModelEditorGestureRefs,
  controller: InteractionController | null,
  handler: InteractionControllerOptions["shotWheel"] | null
): void {
  refs.shotWheel = handler ?? null;
  controller?.setShotWheel(refs.shotWheel);
}

export function applyFilmSetObjectGesture(
  refs: ModelEditorGestureRefs,
  controller: InteractionController | null,
  handler: InteractionControllerOptions["filmSetObjectGesture"] | null
): void {
  refs.object = handler ?? null;
  controller?.setFilmSetObjectGesture(refs.object);
}

/** 注入/替换片场对象局部键盘 action（change: 2026-10-10 片场对象键盘删除/撤销）。 */
export function applyFilmSetObjectAction(
  refs: ModelEditorGestureRefs,
  controller: InteractionController | null,
  handler: InteractionControllerOptions["filmSetObjectAction"] | null
): void {
  refs.objectAction = handler ?? null;
  controller?.setFilmSetObjectAction?.(refs.objectAction);
}
