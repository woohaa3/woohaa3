/**
 * 共享 wheel 入口处理器
 * （change: 2026-10-10-optimize-canvas-interaction-hot-path，从 `interaction-2d-input` 拆出以保持
 * 业务单文件 ≤500 行的体积守卫）。
 *
 * 计时早于前置 `modelPreviewWheel` 命中/坐标换算与任何消费分支，保证 handlerMs 覆盖完整同步
 * 范围；按实际消费的 kind/source 分类记录（design D1）。视口消费本身在
 * `interaction-viewport.onWheel` 完成，这里只负责门禁、分段计时与记录。
 */
import { beginNativeInputTiming } from "../../canvas-runtime/native-input-timing.js";
import { modelPreviewWheel } from "./model-preview.js";
import type { InteractionRecorder } from "../interaction-performance.js";
import type { InputSegments } from "../interaction-input-segments.js";
import type { InteractionCore } from "../interaction-core.js";
import type { createWheelViewport } from "../interaction-viewport.js";

/** 构造共享 wheel 入口；`viewport` 只做消费，计时/记录全部在此（不重复记录）。 */
export function createWheelEntryHandler(
  core: InteractionCore,
  recorder: InteractionRecorder,
  viewport: ReturnType<typeof createWheelViewport>,
  segments: InputSegments
): (event: WheelEvent) => void {
  const { canvas, model } = core;
  return (event: WheelEvent) => {
    segments.reset();
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
    // 共享入口计时：早于前置 `modelPreviewWheel` 命中/坐标换算与任何消费分支。
    const startedAt = recorder?.now();
    const endBridge = beginNativeInputTiming();
    let consumed: { kind: "pan" | "zoom" | "model-preview"; source: string } | null = null;
    try {
      if (segments.measure("hitQueryMs", () => modelPreviewWheel(core, event))) {
        consumed = { kind: "model-preview", source: "model-preview" };
        return;
      }
      const rect = segments.measure("domRectMs", () => {
        const bounds = canvas.getBoundingClientRect();
        return { left: bounds.left, top: bounds.top };
      });
      consumed = segments.measure("viewportWheelMs", () => viewport.onWheel(event, rect));
    } finally {
      const bridge = endBridge();
      if (recorder && startedAt !== undefined && consumed)
        recorder.record(consumed.kind, consumed.source, "wheel", startedAt, segments.current(), undefined, undefined, bridge);
    }
  };
}
