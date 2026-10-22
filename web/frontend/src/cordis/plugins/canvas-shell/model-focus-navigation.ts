/**
 * 聚焦相机导航（键盘飞行 + 滚轮/捏合缩放 + 双指滑动旋转）
 * （change: 2026-09-28-split-frontend-god-plugins，task 3；从 model-gesture-family 拆出）。
 *
 * 由 `model-gesture-family` 注入聚焦会话访问器与 emit 回调；本模块自持飞行 held 状态与
 * Safari gesture 基准，不直接创建 DOM 监听（监听仍由 controller 拥有）。
 */
import type { ModelFocusProjection } from "@woohaa3/contracts";
import { classifyWheelSource, INITIAL_WHEEL_SOURCE, normalizeWheelDelta } from "./input/wheel-gesture.js";

/** 聚焦缩放灵敏度（与参考实现的 pixel/line delta 一致）。 */
const FOCUS_WHEEL_SENSITIVITY_PX = 0.0015;
const FOCUS_WHEEL_SENSITIVITY_LINE = 0.03;

export type FlyKeys = { forward: boolean; back: boolean; left: boolean; right: boolean; up: boolean; down: boolean };
export type FlyModifiers = { fast: boolean; slow: boolean };

export type FocusNavigationDeps = {
  isActive: () => boolean;
  projection: () => ModelFocusProjection | null;
  /** 会话飞行推进；返回是否有变化（与 controller 的相机增量）。 */
  fly: (
    keys: FlyKeys,
    modifiers: FlyModifiers,
    delta: number
  ) => boolean;
  /** 连续缩放（捏合/滚轮）；返回是否有变化。 */
  zoomBy: (factor: number) => boolean;
  rotateBy: (dx: number, dy: number) => boolean;
  emit: () => void;
  /**
   * 事件目标是否由 DOM 自己消费（change: fix-model-focus-navigation-and-camera-parity，D6/task 4.1）。
   *
   * 可滚动 history drawer / model-editor / input/select/textarea/listbox 返回 true：聚焦缩放
   * 不抢占，浏览器默认滚动/编辑保持。canvas、透明 viewfinder 与非交互 chrome 返回 false。
   */
  targetOwnsInput?: (target: EventTarget | null) => boolean;
};

export function createFocusNavigation(deps: FocusNavigationDeps) {
  const heldKeys: FlyKeys = { forward: false, back: false, left: false, right: false, up: false, down: false };
  const heldModifiers: FlyModifiers = { fast: false, slow: false };
  let lastFrameTime: number | null = null;
  let gestureBase: number | null = null;
  let wheelSource = INITIAL_WHEEL_SOURCE;

  const nowMs = (): number => {
    const perf = (globalThis as unknown as { performance?: { now?: () => number } }).performance;
    return perf?.now?.() ?? Date.now();
  };

  /** 单次键盘飞行推进（每帧调用）。 */
  const advanceFly = () => {
    if (!deps.isActive()) {
      lastFrameTime = null;
      return;
    }
    const time = nowMs();
    const delta = lastFrameTime === null ? 0 : Math.min(0.1, Math.max(0, (time - lastFrameTime) / 1000));
    lastFrameTime = time;
    if (delta <= 0) return;
    if (deps.fly(heldKeys, heldModifiers, delta)) deps.emit();
  };

  const resetHeld = () => {
    wheelSource = INITIAL_WHEEL_SOURCE;
    heldKeys.forward = false;
    heldKeys.back = false;
    heldKeys.left = false;
    heldKeys.right = false;
    heldKeys.up = false;
    heldKeys.down = false;
    heldModifiers.fast = false;
    heldModifiers.slow = false;
  };

  /** W/A/S/D/Q/E 键名（用 `code` 兼容不同键盘布局）。 */
  const flyKeyName = (code: string): keyof FlyKeys | null => {
    switch (code) {
      case "KeyW": return "forward";
      case "KeyS": return "back";
      case "KeyA": return "left";
      case "KeyD": return "right";
      case "KeyE": return "up";
      case "KeyQ": return "down";
      default: return null;
    }
  };

  /** 更新 held 飞行键与速度修饰键（Shift 快、Ctrl/Alt 慢）。 */
  const applyFlyKey = (event: KeyboardEvent, down: boolean) => {
    const name = flyKeyName(event.code);
    if (name) heldKeys[name] = down;
    heldModifiers.fast = event.shiftKey === true;
    heldModifiers.slow = event.ctrlKey === true || event.altKey === true;
  };

  /** document capture 阶段的聚焦滚轮/捏合；返回是否已消费。 */
  const onDocumentWheel = (event: WheelEvent, modalActive: boolean): boolean => {
    const active = deps.isActive();
    if (modalActive || !active) {
      return false;
    }
    // DOM 语义区域（可滚动/可编辑）优先消费：不抢滚轮、不阻止默认滚动（design D6）。
    const targetOwnsInput = deps.targetOwnsInput?.(event.target) ?? false;
    if (targetOwnsInput) {
      return false;
    }
    event.preventDefault();
    // 沿用 2D 画布的输入来源识别：双指滑动直接旋转，捏合始终优先缩放。
    if (!event.ctrlKey && !event.metaKey) {
      wheelSource = classifyWheelSource({
        deltaX: event.deltaX ?? 0,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        ctrlKey: false,
        metaKey: false,
        clientX: event.clientX,
        clientY: event.clientY,
        timeStamp: event.timeStamp ?? nowMs()
      }, wheelSource);
      if (wheelSource.source === "trackpad") {
        const { dx, dy } = normalizeWheelDelta(event);
        if (deps.rotateBy(dx, dy)) deps.emit();
        return true;
      }
    }
    // 鼠标滚轮与触控板捏合连续改变主观察相机距离。
    const sensitivity = event.deltaMode === 1
      ? FOCUS_WHEEL_SENSITIVITY_LINE
      : FOCUS_WHEEL_SENSITIVITY_PX;
    const factor = Math.exp(-event.deltaY * sensitivity);
    const changed = deps.zoomBy(factor);
    if (changed) deps.emit();
    return true;
  };

  const onGestureStart = (event: Event, modalActive: boolean): void => {
    if (modalActive || !deps.isActive()) return;
    if (deps.targetOwnsInput?.(event.target)) return;
    event.preventDefault();
    gestureBase = deps.projection()?.distance ?? null;
  };
  const onGestureChange = (event: Event, modalActive: boolean): void => {
    if (modalActive || !deps.isActive() || gestureBase === null) return;
    if (deps.targetOwnsInput?.(event.target)) return;
    event.preventDefault();
    const scale = (event as Event & { scale?: number }).scale;
    if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) return;
    const current = deps.projection()?.distance ?? gestureBase;
    const target = gestureBase / scale;
    if (target > 0 && deps.zoomBy(current / target)) deps.emit();
  };
  const onGestureEnd = (event: Event): void => {
    if (!deps.isActive()) return;
    event.preventDefault();
    gestureBase = null;
  };

  return {
    advanceFly,
    resetHeld,
    flyKeyName,
    applyFlyKey,
    onDocumentWheel,
    onGestureStart,
    onGestureChange,
    onGestureEnd
  };
}
