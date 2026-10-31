/**
 * 画布事件监听注册/注销
 * （change: 2026-09-28-split-frontend-god-plugins 后续拆分；从 `interaction-controller` 抽出）。
 *
 * 只集中 pointer/keyboard/wheel/gesture/resize 的 add/remove，保持在文件体积上限内并让
 * controller 只关注生命周期与返回契约。
 */
import type { create2dInputFamily } from "./interaction-2d-input.js";
import type { createKeyboardShortcuts } from "./interaction-keyboard.js";
import type { createDoubleClickHandler } from "./interaction-double-click.js";
import type { createSurfaceInteractions } from "./interaction-surface.js";

type Input = ReturnType<typeof create2dInputFamily>;
type Keyboard = ReturnType<typeof createKeyboardShortcuts>;
type DblClick = ReturnType<typeof createDoubleClickHandler>;
type Handlers = ReturnType<typeof createSurfaceInteractions>["handlers"];

export function installCanvasListeners(
  canvas: HTMLCanvasElement,
  target: Window & typeof globalThis,
  input: Input,
  keyboard: Keyboard,
  dblclick: DblClick,
  handlers: Handlers
): void {
  canvas.addEventListener("pointerdown", input.onPointerDown);
  canvas.addEventListener("pointermove", input.onPointerMove);
  canvas.addEventListener("pointerup", input.onPointerUp);
  canvas.addEventListener("pointercancel", input.onPointerCancel);
  canvas.addEventListener("lostpointercapture", input.onPointerCancel);
  canvas.addEventListener("pointerleave", input.onPointerLeave);
  canvas.addEventListener("wheel", input.onWheel, { passive: false });
  // 聚焦缩放在 document capture 阶段：覆盖层上的滚轮/捏合也必须只调相机、取消默认缩放。
  target.document?.addEventListener?.("wheel", handlers.onDocumentWheel, { capture: true, passive: false });
  target.document?.addEventListener?.("pointerdown", handlers.onDocumentPointerDown, { capture: true });
  target.document?.addEventListener?.("focusin", handlers.onDocumentFocusChange, { capture: true });
  target.document?.addEventListener?.("focusout", handlers.onDocumentFocusChange, { capture: true });
  target.addEventListener("blur", handlers.onDocumentBlur);
  target.document?.addEventListener?.("visibilitychange", handlers.onDocumentVisibility);
  // Safari 触控板捏合（GestureEvent）。
  target.document?.addEventListener?.("gesturestart", handlers.onGestureStart, { capture: true, passive: false });
  target.document?.addEventListener?.("gesturechange", handlers.onGestureChange, { capture: true, passive: false });
  target.document?.addEventListener?.("gestureend", handlers.onGestureEnd, { capture: true, passive: false });
  canvas.addEventListener("contextmenu", input.onContextMenu);
  canvas.addEventListener("dblclick", dblclick.onDoubleClick);
  target.addEventListener("keydown", keyboard.onKeyDown);
  target.addEventListener("keyup", keyboard.onKeyUp);
  // Space 释放必须在捕获阶段复位：浮层/文本输入层的 `keyup` stopPropagation 会吞掉冒泡阶段，
  // 让「按住空格临时平移」闩锁再也清不掉（change: fix-space-pan-latch-after-focus-exit）。
  target.addEventListener("keyup", keyboard.onSpaceRelease, { capture: true });
  // DOM `copy`：桌面原生 Edit 菜单会先吃掉 Cmd+C，页面只剩下这个事件
  // （change: fix-desktop-native-menu-clipboard-shortcuts）。
  target.document?.addEventListener?.("copy", keyboard.onCopy);
  target.document?.addEventListener?.("visibilitychange", input.onVisibilityChange);
  target.addEventListener("blur", input.onBlur);
  // 窗口 resize 是可见 surface 变化：显式失效，避免静止帧跳过重建后尺寸不跟随。
  target.addEventListener("resize", handlers.onWindowResize);
}

export function removeCanvasListeners(
  canvas: HTMLCanvasElement,
  target: Window & typeof globalThis,
  input: Input,
  keyboard: Keyboard,
  dblclick: DblClick,
  handlers: Handlers
): void {
  canvas.removeEventListener("pointerdown", input.onPointerDown);
  canvas.removeEventListener("pointermove", input.onPointerMove);
  canvas.removeEventListener("pointerup", input.onPointerUp);
  canvas.removeEventListener("pointercancel", input.onPointerCancel);
  canvas.removeEventListener("lostpointercapture", input.onPointerCancel);
  canvas.removeEventListener("pointerleave", input.onPointerLeave);
  canvas.removeEventListener("wheel", input.onWheel);
  target.document?.removeEventListener?.("wheel", handlers.onDocumentWheel, { capture: true });
  target.document?.removeEventListener?.("pointerdown", handlers.onDocumentPointerDown, { capture: true });
  target.document?.removeEventListener?.("focusin", handlers.onDocumentFocusChange, { capture: true });
  target.document?.removeEventListener?.("focusout", handlers.onDocumentFocusChange, { capture: true });
  target.removeEventListener("blur", handlers.onDocumentBlur);
  target.document?.removeEventListener?.("visibilitychange", handlers.onDocumentVisibility);
  target.document?.removeEventListener?.("gesturestart", handlers.onGestureStart, { capture: true });
  target.document?.removeEventListener?.("gesturechange", handlers.onGestureChange, { capture: true });
  target.document?.removeEventListener?.("gestureend", handlers.onGestureEnd, { capture: true });
  canvas.removeEventListener("contextmenu", input.onContextMenu);
  canvas.removeEventListener("dblclick", dblclick.onDoubleClick);
  target.removeEventListener("keydown", keyboard.onKeyDown);
  target.removeEventListener("keyup", keyboard.onKeyUp);
  target.removeEventListener("keyup", keyboard.onSpaceRelease, { capture: true });
  target.document?.removeEventListener?.("copy", keyboard.onCopy);
  target.document?.removeEventListener?.("visibilitychange", input.onVisibilityChange);
  target.removeEventListener("blur", input.onBlur);
  target.removeEventListener("resize", handlers.onWindowResize);
}
