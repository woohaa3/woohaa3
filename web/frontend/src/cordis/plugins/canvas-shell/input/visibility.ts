import type { InteractionCore } from "../interaction-core.js";
export function createVisibilityHandler(core:InteractionCore, cancelDragGesture:()=>void, cancelAggregate:()=>void) {
  const {state}=core;
  return () => {
    if (core.target.document?.visibilityState !== "visible") {
      core.suspendHoverPlayback();
      core.clearHover();
      // 页面隐藏期间收不到 keyup：清掉 Space 临时平移闩锁，回来后仍能点选节点。
      state.spacePressed = false;
      // 页面不可见取消未提交的拖动粘连 / 聚合拉线手势（design D6）。
      if (state.gesture.kind === "model-preview" || state.gesture.kind === "history-press" || state.gesture.kind === "group-badge-press" || state.gesture.kind === "group-badge-resize") cancelDragGesture();
      else if (state.gesture.kind === "drag") cancelDragGesture();
      else if (state.gesture.kind === "aggregate-connect") cancelAggregate();
    }
  };
}
