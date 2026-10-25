/**
 * 共享 wheel 入口处理器
 * （change: 2026-10-10-optimize-canvas-interaction-hot-path，从 `interaction-2d-input` 拆出以保持
 * 业务单文件 ≤500 行的体积守卫）。
 *
 * 只负责门禁与分派：视口消费本身在 `interaction-viewport.onWheel` 完成。
 */
import { modelPreviewWheel } from "./model-preview.js";
import type { InteractionCore } from "../interaction-core.js";
import type { createWheelViewport } from "../interaction-viewport.js";

/** 构造共享 wheel 入口；`viewport` 只做消费。 */
export function createWheelEntryHandler(
  core: InteractionCore,
  viewport: ReturnType<typeof createWheelViewport>
): (event: WheelEvent) => void {
  const { canvas, model } = core;
  return (event: WheelEvent) => {
    // modal 打开时滚轮不得缩放画布（design D6）。
    const imageFocused = core.options.isImageFocused?.() ?? !!core.options.getImageFocus?.();
    if (imageFocused) {
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
    if (modelPreviewWheel(core, event)) return;
    const bounds = canvas.getBoundingClientRect();
    viewport.onWheel(event, { left: bounds.left, top: bounds.top });
  };
}
