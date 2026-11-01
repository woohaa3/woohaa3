import type { InteractionCore } from "../interaction-core.js";
import { createVisibilityHandler } from "./visibility.js";

/** 输入中断只取消本地预览，不走 pointerup 的提交路径。 */
export function createCancellationHandlers(
  core: InteractionCore,
  cancelDrag: () => void,
  cancelAggregate: () => void,
) {
  const { canvas, model, state } = core;
  const onPointerCancel = (event: PointerEvent) => {
    if (model.active) {
      core.clearHeldKeys();
      return;
    }
    if (state.gesture.kind === "none") return;
    if (
      "pointerId" in state.gesture &&
      state.gesture.pointerId !== event.pointerId
    )
      return;
    try {
      canvas.releasePointerCapture?.(event.pointerId);
    } catch {
      // 指针可能已释放。
    }
    if (state.gesture.kind === "aggregate-connect") cancelAggregate();
    else cancelDrag();
  };

  const onBlur = () => {
    core.suspendHoverPlayback();
    core.clearHover();
    // 窗口失焦时 Space 的 keyup 可能永远收不到：不清理会让左键点击永久退化为平移
    // （change: fix-space-pan-latch-after-focus-exit）。
    state.spacePressed = false;
    if (state.gesture.kind === "model-preview" || state.gesture.kind === "history-press") cancelDrag();
    else if (state.gesture.kind === "drag") {
      cancelDrag();
      return;
    }
    if (state.gesture.kind === "aggregate-connect") {
      cancelAggregate();
      return;
    }
    core.clearHeldKeys();
  };

  return {
    onPointerCancel,
    onBlur,
    onVisibilityChange: createVisibilityHandler(
      core,
      cancelDrag,
      cancelAggregate,
    ),
  };
}
