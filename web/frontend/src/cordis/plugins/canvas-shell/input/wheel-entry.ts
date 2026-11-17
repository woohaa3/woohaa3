/** Shared wheel entry: gates focused/modal input and delegates to the viewport. */
import type { InteractionCore } from "../interaction-core.js";
import type { createWheelViewport } from "../interaction-viewport.js";

export function createWheelEntryHandler(
  core: InteractionCore,
  viewport: ReturnType<typeof createWheelViewport>
): (event: WheelEvent) => void {
  const { canvas, model } = core;
  const handler = (event: WheelEvent): void => {
    // modal 打开时滚轮不得缩放画布（design D6）。
    const imageFocused = core.options.isImageFocused?.() ?? !!core.options.getImageFocus?.();
    if (imageFocused && !(core.options.isImageFocusPending?.() ?? false)) {
      event.preventDefault();
      if (!core.focusInputBlocked() && core.options.getImageViewportTarget?.()?.read()) viewport.onWheel(event);
      return;
    }
    if (core.modalActive()) {
      event.preventDefault();
      return;
    }
    // 聚焦查看：滚轮缩放由 document capture 阶段的 onDocumentWheel 处理。
    if (model.active) {
      event.preventDefault();
      return;
    }
    // 视频聚焦：滚轮由聚焦 overlay 消费，普通画布不缩放。
    if (core.options.isVideoFocused?.() ?? !!core.options.getVideoFocus?.()) {
      event.preventDefault();
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    viewport.onWheel(event, { left: bounds.left, top: bounds.top });
  };

  return handler;
}
