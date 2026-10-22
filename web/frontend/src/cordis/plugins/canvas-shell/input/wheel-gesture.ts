/**
 * 浏览器归一化 wheel/pinch（change: align-godot-canvas-interactions，任务 2.4 / design D2；
 * 对齐修正 change: add-audio-video-generation-and-align-model-catalog）。
 *
 * 为什么在 Web 侧做：只有浏览器持有 `WheelEvent` 的原始 `deltaX/deltaY/deltaMode/ctrlKey`
 * 与指针位置；单靠原生累加器会丢失横向像素增量与 pinch 语义。
 *
 * 分类规则**严格对齐来源项目 xyflow 的 `useWheelViewportGesture`**（其 xyflow 配
 * `zoomOnScroll={false} panOnScroll={false}`，滚轮/触控板/捏合全部由该层处理）：
 * - `ctrlKey || metaKey` → pinch/连续缩放（浏览器把触控板捏合表达为 ctrl+wheel）；
 * - 有状态来源分类 `classifyWheelSource`：
 *   - `absX !== 0 || (deltaMode===0 && absY < 16)` → 触控板（双指双轴平移）；
 *   - `deltaMode !== 0`（行/页模式）→ 鼠标；
 *   - 否则（像素模式、无横向、大步长）→ 鼠标；
 *   - 200ms 内的连续事件沿用上一次判定，超出则重置为 unknown。
 * - 鼠标滚轮 → 按每次 1.1 倍分级缩放；
 * - 触控板 → 双指平移（方向与参考一致：`x - deltaX`, `y - deltaY`）。
 *
 * 纯函数、无 DOM 依赖，便于单测。
 */

import { clampWoohaa3CanvasZoom, zoomViewportAroundScreenPoint } from "@woohaa3/contracts";

/** 鼠标滚轮分级缩放倍率（spec：每次 1.1 倍）。 */
export const WHEEL_ZOOM_STEP = 1.1;

/** pinch 连续缩放灵敏度（与参考 `zoomSensitivity * pinchZoomBoost` 一致）。 */
export const PINCH_ZOOM_SENSITIVITY = 0.014;

/** wheel/pinch 空闲多久后提交一次最终视口（spec：120ms）。 */
export const VIEWPORT_COMMIT_IDLE_MS = 120;

/** 来源状态在多久没有后续事件后重置（与参考 200ms 一致）。 */
export const WHEEL_SOURCE_RESET_MS = 200;

/** `deltaMode` 常量（DOM_DELTA_PIXEL / LINE / PAGE）。 */
export const DELTA_MODE_PIXEL = 0;
export const DELTA_MODE_LINE = 1;
export const DELTA_MODE_PAGE = 2;

/** 行/页模式换算为像素的近似步长。 */
const LINE_HEIGHT_PX = 16;
const PAGE_HEIGHT_PX = 800;

export type WheelSource = "mouse" | "trackpad" | "pinch";

export type WheelSourceState = {
  source: "mouse" | "trackpad" | "unknown";
  lastEventTime: number;
};

export const INITIAL_WHEEL_SOURCE: WheelSourceState = { source: "unknown", lastEventTime: Number.NEGATIVE_INFINITY };

export type NormalizedWheel =
  | { kind: "zoom"; source: "mouse"; /** 缩放因子（>1 放大，<1 缩小） */ factor: number; direction: 1 | -1; screen: { x: number; y: number } }
  | { kind: "zoom"; source: "pinch"; /** 连续缩放因子（>1 放大，<1 缩小） */ factor: number; deltaY: number; screen: { x: number; y: number } }
  | { kind: "pan"; source: "trackpad"; dx: number; dy: number };

export type WheelEventLike = {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  /** 相对视口的指针位置（CSS 像素）。 */
  clientX: number;
  clientY: number;
  /** 事件时间戳（用于来源状态重置）；缺省视为 0。 */
  timeStamp?: number;
};

/** 把 `deltaMode` 归一化为像素。行/页模式按固定步长换算。 */
export function normalizeWheelDelta(event: Pick<WheelEventLike, "deltaX" | "deltaY" | "deltaMode">): {
  dx: number;
  dy: number;
} {
  switch (event.deltaMode) {
    case DELTA_MODE_LINE:
      return { dx: event.deltaX * LINE_HEIGHT_PX, dy: event.deltaY * LINE_HEIGHT_PX };
    case DELTA_MODE_PAGE:
      return { dx: event.deltaX * PAGE_HEIGHT_PX, dy: event.deltaY * PAGE_HEIGHT_PX };
    default:
      return { dx: event.deltaX, dy: event.deltaY };
  }
}

/**
 * 有状态来源分类（与参考 `classifyWheelSource` 一致）。
 *
 * 触控板的典型特征是**横向分量**或**小步长像素增量**（逐帧多个 <16px 的竖直滚动）；
 * 鼠标滚轮是行/页模式或较大整步长像素。竖直双指滚动 `deltaX===0` 也必须判为触控板，
 * 否则会被误判成鼠标滚轮缩放。
 */
export function classifyWheelSource(event: WheelEventLike, state: WheelSourceState): WheelSourceState {
  const now = event.timeStamp ?? 0;
  const next: WheelSourceState = now - state.lastEventTime > WHEEL_SOURCE_RESET_MS
    ? { source: "unknown", lastEventTime: now }
    : { ...state, lastEventTime: now };
  const absX = Math.abs(event.deltaX);
  const absY = Math.abs(event.deltaY);
  if (absX !== 0 || (event.deltaMode === DELTA_MODE_PIXEL && absY < 16)) {
    next.source = "trackpad";
  } else if (event.deltaMode !== DELTA_MODE_PIXEL) {
    next.source = "mouse";
  } else if (next.source === "unknown") {
    next.source = "mouse";
  }
  return next;
}

export type WheelClassification = {
  wheel: NormalizedWheel | null;
  control: WheelSourceState;
};

/** 分类一次 wheel 事件；返回归一化手势与更新后的来源状态。 */
export function classifyWheelEvent(
  event: WheelEventLike,
  previous: WheelSourceState = INITIAL_WHEEL_SOURCE
): WheelClassification {
  const control = classifyWheelSource(event, previous);
  const { dx, dy } = normalizeWheelDelta(event);
  const screen = { x: event.clientX, y: event.clientY };
  if (dx === 0 && dy === 0) return { wheel: null, control };

  if (event.ctrlKey || event.metaKey) {
    // pinch / 主修饰键滚轮：连续缩放。
    const factor = Math.exp(-dy * PINCH_ZOOM_SENSITIVITY);
    return { wheel: { kind: "zoom", source: "pinch", factor, deltaY: dy, screen }, control };
  }

  if (control.source === "trackpad") {
    return { wheel: { kind: "pan", source: "trackpad", dx, dy }, control };
  }

  const direction: 1 | -1 = dy > 0 ? -1 : 1;
  const factor = direction > 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
  return { wheel: { kind: "zoom", source: "mouse", direction, factor, screen }, control };
}

/**
 * 视口手势会话状态机（任务 2.5）：热路径只做本地预览，冷路径提交一次最终视口。
 *
 * - `begin` 记录手势起始视口；
 * - `update` 返回本地预览视口，并（对 wheel/pinch）重置 120ms idle 计时；
 * - 拖拽释放调用 `finish`，wheel/pinch idle 到期调用 `finishIfIdle`；
 * - 只有净变化非零才产生一次提交；回到起始值不提交。
 *
 * 纯状态机，不含计时器本身；调用方（DOM 宿主）负责在 `idleMs` 后调用 `finishIfIdle`。
 */
export type ViewportState = { x: number; y: number; zoom: number };

export class ViewportGestureSession {
  private start: ViewportState | null = null;
  private current: ViewportState | null = null;

  get active(): boolean {
    return this.start !== null;
  }

  get previewValue(): ViewportState | null {
    return this.current;
  }

  begin(viewport: ViewportState): void {
    this.start = { ...viewport };
    this.current = { ...viewport };
  }

  update(next: ViewportState): ViewportState {
    if (!this.start) this.begin(next);
    else this.current = { ...next };
    return this.current as ViewportState;
  }

  /**
   * 结束手势并返回需要提交的最终视口；无净变化时返回 `null`（不提交命令）。
   * 无论是否提交都会结束当前手势。
   */
  finish(): ViewportState | null {
    const start = this.start;
    const current = this.current;
    this.start = null;
    this.current = null;
    if (!start || !current) return null;
    return viewportsEqual(start, current) ? null : current;
  }

  cancel(): void {
    this.start = null;
    this.current = null;
  }
}

export function viewportsEqual(a: ViewportState, b: ViewportState): boolean {
  return Math.abs(a.x - b.x) < 1e-9
    && Math.abs(a.y - b.y) < 1e-9
    && Math.abs(a.zoom - b.zoom) < 1e-9;
}

/**
 * wheel 手势累加器（性能修复）。
 *
 * **为什么需要**：每个 wheel 事件都跨 JS↔wasm 边界的开销极高（同步调用
 * 调用 + JSON 编解码）。触控板高频滚轮下每秒数十次会把帧率打到 2–3 fps（CPU profile 显示
 * `sendGesture` 占 50.7% 采样）。因此把一帧内的多个 wheel 事件合并成**一次**跨边界调用：
 * 平移分量相加，缩放因子相乘，缩放锚点取最后一次事件。
 */
export type WheelGestureAccumulator = {
  panDx: number;
  panDy: number;
  zoomFactor: number;
  zoomScreen: { x: number; y: number } | null;
  hasPan: boolean;
  hasZoom: boolean;
};

export function createWheelGestureAccumulator(): WheelGestureAccumulator {
  return { panDx: 0, panDy: 0, zoomFactor: 1, zoomScreen: null, hasPan: false, hasZoom: false };
}

export function accumulateWheelGesture(acc: WheelGestureAccumulator, wheel: NormalizedWheel): void {
  if (wheel.kind === "pan") {
    acc.panDx += wheel.dx;
    acc.panDy += wheel.dy;
    acc.hasPan = true;
    return;
  }
  acc.zoomFactor *= wheel.factor;
  acc.zoomScreen = wheel.screen;
  acc.hasZoom = true;
}

/** 合并后的手势消息；字段缺省表示该帧没有该分量。 */
export type WheelGestureMessage = {
  pan?: { dx: number; dy: number };
  zoom?: { factor: number; screen: { x: number; y: number } };
};

/**
 * 取出并清空累加器。无任何分量时返回 `null`（调用方不产生跨边界调用）。
 */
export function takeWheelGesture(acc: WheelGestureAccumulator): WheelGestureMessage | null {
  if (!acc.hasPan && !acc.hasZoom) return null;
  const message: WheelGestureMessage = {};
  if (acc.hasPan) message.pan = { dx: acc.panDx, dy: acc.panDy };
  if (acc.hasZoom && acc.zoomScreen) message.zoom = { factor: acc.zoomFactor, screen: acc.zoomScreen };
  acc.panDx = 0;
  acc.panDy = 0;
  acc.zoomFactor = 1;
  acc.zoomScreen = null;
  acc.hasPan = false;
  acc.hasZoom = false;
  return Object.keys(message).length > 0 ? message : null;
}

/**
 * 把归一化的 wheel 手势应用到视口，返回本地预览视口。
 *
 * - 鼠标分级缩放：以指针为中心按 1.1 倍缩放（`zoomViewportAroundScreenPoint` 保持指针下
 *   逻辑坐标不变）。
 * - pinch 连续缩放：以指针为中心按连续 factor 缩放。
 * - 触控板平移：`x/y` **减去** delta（与 xyflow 的自然滚动方向一致）。
 *
 * 所有缩放都受规范 min/max zoom 限制。
 */
export function applyWheelToViewport(
  viewport: ViewportState,
  wheel: NormalizedWheel
): ViewportState {
  if (wheel.kind === "zoom") {
    const nextZoom = wheel.source === "mouse"
      ? viewport.zoom * (wheel.direction > 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP)
      : viewport.zoom * wheel.factor;
    return zoomViewportAroundScreenPoint(viewport, clampWoohaa3CanvasZoom(nextZoom), wheel.screen);
  }
  return { x: viewport.x - wheel.dx, y: viewport.y - wheel.dy, zoom: viewport.zoom };
}
