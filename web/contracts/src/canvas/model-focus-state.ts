/**
 * 模型聚焦查看状态机
 * （change: add-model-focus-viewing，任务 1.3 / 1.5 / 1.6；design D1/D5）。
 *
 * 纯函数、无副作用：只描述 `idle | focused` 与相机手势。它不持有 DOM、Bevy 或规范状态，
 * 因此可以在无浏览器环境单测，并保证聚焦状态**不可能**进入 ServerCanvas / CanvasCommand。
 *
 * 浏览器入口只调用 `enter` / `applyCamera` / `beginGesture` / `finishGesture` /
 * `exit` 等纯转移，然后把 `snapshot()` 投影进 `CanvasRenderScene.modelFocus`。
 */
import {
  clampDistance,
  clampFlySpeed,
  clampPitch,
  normalizeYaw,
  MODEL_FOCUS_DEFAULT_FLY_SPEED,
  MODEL_FOCUS_DOLLY_IN,
  MODEL_FOCUS_DOLLY_OUT,
  MODEL_FOCUS_FOV,
  MODEL_FOCUS_LOOK_SENSITIVITY_DEG_PER_PX,
  MODEL_FOCUS_SPEED_FAST,
  MODEL_FOCUS_SPEED_SLOW,
  MODEL_FOCUS_VERSION,
  type ModelFocusCamera,
  type ModelFocusProjection
} from "./model-focus.js";
import {
  updatePlacementDrag,
  type PlacementDrag,
  type PlacementDraft
} from "./model-placement.js";
import type { Vec3 } from "./model-transform.js";

/** 聚焦入口条件常量（design D5）：450ms / 28 CSS px 内的第二次点击。 */
export const FOCUS_DOUBLE_CLICK_MS = 450;
export const FOCUS_DOUBLE_CLICK_PX = 28;

export type ModelFocusGesture =
  | { kind: "none" }
  | { kind: "look"; pointerId: number; lastX: number; lastY: number }
  | { kind: "pan"; pointerId: number; lastX: number; lastY: number }
  /**
   * 直接编辑模型 placement 的手势（change: add-model-focus-editing，任务 2.1）。
   * `drag` 冻结 canonical/working placement 为 origin 与相机朝向平面，高频预览由
   * `updatePlacementDrag` 纯函数推进。
   */
  | { kind: "model"; pointerId: number; drag: PlacementDrag };

export type ModelFocusState =
  | { phase: "idle" }
  | {
      phase: "focused";
      nodeId: string;
      camera: ModelFocusCamera;
      /** 目标包围球半径（世界单位）；用于查看指示与投影。 */
      radius: number;
      gesture: ModelFocusGesture;
      /**
       * 当前 model placement 手势的高频 preview（change: add-model-focus-editing）。
       * 非 model 手势时为 `undefined`。释放时经 `finishModelGesture` 取出并判定净变化。
       */
      modelPreview?: PlacementDraft;
      /** 进入快照：退出时精确恢复。 */
      savedProjection2d: unknown;
    };

/** 聚焦相机初始值：由调用方传入目标中心/半径与 aspect 计算后的距离。 */
export type EnterFocusInput = {
  nodeId: string;
  target: Vec3;
  radius: number;
  distance: number;
  savedProjection2d: unknown;
  flySpeed?: number;
};

export function initialFocusState(): ModelFocusState {
  return { phase: "idle" };
}

/** 由进入参数派生初始聚焦相机。 */
function initialCamera(input: EnterFocusInput): ModelFocusCamera {
  return {
    target: [...input.target],
    yaw: 0,
    pitch: -0.35,
    distance: clampDistance(input.distance, input.radius),
    flySpeed: clampFlySpeed(input.flySpeed ?? MODEL_FOCUS_DEFAULT_FLY_SPEED)
  };
}

/**
 * 进入聚焦（change: fix-model-focus-navigation-and-camera-parity，design D4）。
 *
 * 只允许 `idle -> focused` 写入进入快照；已聚焦时同 node 为 no-op，不同 node 只替换目标
 * identity/相机（**不**覆盖 `savedProjection2d`）。目标与距离必须合法，否则保持原状态。
 */
export function enterFocus(state: ModelFocusState, input: EnterFocusInput): ModelFocusState {
  if (!isValidTarget(input.target) || !(Number.isFinite(input.distance) && input.distance > 0)) {
    return state;
  }
  if (state.phase === "focused") {
    if (state.nodeId === input.nodeId) return state;
    return {
      ...state,
      nodeId: input.nodeId,
      camera: initialCamera(input),
      radius: Number.isFinite(input.radius) && input.radius > 0 ? input.radius : 1,
      gesture: { kind: "none" },
      modelPreview: undefined
    };
  }
  return {
    phase: "focused",
    nodeId: input.nodeId,
    camera: initialCamera(input),
    radius: Number.isFinite(input.radius) && input.radius > 0 ? input.radius : 1,
    gesture: { kind: "none" },
    savedProjection2d: input.savedProjection2d
  };
}

/**
 * 重新取景（change: fix-model-focus-navigation-and-camera-parity，design D4）。
 *
 * 无快照副作用：只更新目标 AABB center/radius 与（可选）distance，取消活动 gesture；
 * `savedProjection2d`、focus node identity 与 owner 不变。用于历史 preview、canonical 内容
 * 替换与 content rect 变化。
 */
export function reframeFocus(
  state: ModelFocusState,
  input: { nodeId?: string; target: Vec3; radius: number; distance?: number }
): ModelFocusState {
  if (state.phase !== "focused") return state;
  if (input.nodeId !== undefined && input.nodeId !== state.nodeId) return state;
  if (!isValidTarget(input.target)) return state;
  const radius = Number.isFinite(input.radius) && input.radius > 0 ? input.radius : state.radius;
  const requested =
    input.distance !== undefined && Number.isFinite(input.distance) && input.distance > 0
      ? input.distance
      : state.camera.distance;
  const distance = clampDistance(requested, radius);
  return {
    ...state,
    camera: { ...state.camera, target: [...input.target], distance },
    radius,
    gesture: { kind: "none" },
    modelPreview: undefined
  };
}

/** 读取当前聚焦相机快照（owner 切换时保存 direct 主观察相机）；未聚焦返回 null。 */
export function focusCameraSnapshot(state: ModelFocusState): ModelFocusCamera | null {
  if (state.phase !== "focused") return null;
  return { ...state.camera, target: [...state.camera.target] };
}

/** 恢复一个此前保存的聚焦相机（history -> direct）；未聚焦或非法输入为 no-op。 */
export function restoreFocusCamera(state: ModelFocusState, camera: ModelFocusCamera): ModelFocusState {
  if (state.phase !== "focused") return state;
  if (!isValidTarget(camera.target)) return state;
  if (![camera.yaw, camera.pitch, camera.distance, camera.flySpeed].every(Number.isFinite)) return state;
  return {
    ...state,
    camera: {
      target: [...camera.target],
      yaw: camera.yaw,
      pitch: clampPitch(camera.pitch),
      distance: clampDistance(camera.distance, state.radius),
      flySpeed: clampFlySpeed(camera.flySpeed)
    },
    gesture: { kind: "none" },
    modelPreview: undefined
  };
}

/** 退出聚焦；返回 idle 与进入快照（供精确恢复）。 */
export function exitFocus(state: ModelFocusState): { state: ModelFocusState; restored: unknown } {
  if (state.phase === "idle") return { state, restored: null };
  return { state: { phase: "idle" }, restored: state.savedProjection2d };
}

export function isFocused(state: ModelFocusState): boolean {
  return state.phase === "focused";
}

export function focusedNodeId(state: ModelFocusState): string | null {
  return state.phase === "focused" ? state.nodeId : null;
}

/** 目标删除/失效（权威投影移除目标或模型快照）→ 自动退出。 */
export function invalidateTarget(state: ModelFocusState, validNodeIds: ReadonlySet<string>): ModelFocusState {
  if (state.phase !== "focused") return state;
  return validNodeIds.has(state.nodeId) ? state : { phase: "idle" };
}

// ── 相机手势 ──────────────────────────────────────────────────────────────────

export function beginGesture(
  state: ModelFocusState,
  gesture: { kind: "look" | "pan"; pointerId: number; x: number; y: number }
): ModelFocusState {
  if (state.phase !== "focused") return state;
  return {
    ...state,
    gesture:
      gesture.kind === "look"
        ? { kind: "look", pointerId: gesture.pointerId, lastX: gesture.x, lastY: gesture.y }
        : { kind: "pan", pointerId: gesture.pointerId, lastX: gesture.x, lastY: gesture.y }
  };
}

/**
 * 开始模型 placement 手势（change: add-model-focus-editing，任务 2.1/2.2/2.3）。
 *
 * `drag` 由 `beginPlacementDrag` 在 ray/AABB 命中后构造；为 `null` 时不改变状态。
 * 已存在相机手势时被模型手势覆盖（模型手势优先级最高）。
 */
export function beginModelGesture(
  state: ModelFocusState,
  input: { pointerId: number; drag: PlacementDrag | null }
): ModelFocusState {
  if (state.phase !== "focused" || !input.drag) return state;
  return { ...state, gesture: { kind: "model", pointerId: input.pointerId, drag: input.drag } };
}

/** 当前指针手势是否由 `pointerId` 拥有。 */
function ownsGesture(state: ModelFocusState, pointerId: number): boolean {
  return state.phase === "focused" && state.gesture.kind !== "none" && state.gesture.pointerId === pointerId;
}

/** 指针移动：look 绕 target 旋转，pan 沿相机平面平移，model 推进 placement 手势。 */
export function moveGesture(
  state: ModelFocusState,
  pointerId: number,
  x: number,
  y: number,
  surfaceHeight: number,
  /**
   * 仅 model 手势需要：surface 宽度与相机，用于 ray-plane 求交。
   * 缺省（未提供）时忽略 model 手势移动，保持纯相机转移的向后兼容。
   */
  modelInput?: {
    surface: { width: number; height: number };
    camera: ModelFocusCamera;
  }
): ModelFocusState {
  if (state.phase !== "focused") return state;
  const gesture = state.gesture;
  if (gesture.kind === "none" || gesture.pointerId !== pointerId) return state;
  if (gesture.kind === "model") {
    if (!modelInput) return state;
    const preview = updatePlacementDrag(gesture.drag, {
      x,
      y,
      camera: modelInput.camera,
      surface: modelInput.surface
    });
    // 非法采样（近平行/负交点/NaN）：跳过该帧，保留上一 preview（不产生跳变）。
    if (!preview) return state;
    return { ...state, gesture: { kind: "model", pointerId, drag: gesture.drag }, modelPreview: preview };
  }
  const dx = x - gesture.lastX;
  const dy = y - gesture.lastY;
  const step = (MODEL_FOCUS_LOOK_SENSITIVITY_DEG_PER_PX * Math.PI) / 180;
  if (gesture.kind === "look") {
    const camera: ModelFocusCamera = {
      ...state.camera,
      yaw: normalizeYaw(state.camera.yaw - dx * step),
      pitch: clampPitch(state.camera.pitch - dy * step)
    };
    return { ...state, camera, gesture: { ...gesture, lastX: x, lastY: y } };
  }
  // pan：沿相机右/上平面移动 target（距离越大移动越快，保持视角）。
  const { right, up } = cameraBasis(state.camera);
  const worldPerPixel = (2 * state.camera.distance * Math.tan(MODEL_FOCUS_FOV / 2)) / Math.max(1, surfaceHeight);
  const target: Vec3 = [
    state.camera.target[0] - (right[0] * dx + up[0] * -dy) * worldPerPixel,
    state.camera.target[1] - (right[1] * dx + up[1] * -dy) * worldPerPixel,
    state.camera.target[2] - (right[2] * dx + up[2] * -dy) * worldPerPixel
  ];
  return { ...state, camera: { ...state.camera, target }, gesture: { ...gesture, lastX: x, lastY: y } };
}

/** 结束手势（pointerup / pointercancel / blur / modal）。 */
export function finishGesture(state: ModelFocusState, pointerId?: number): ModelFocusState {
  if (state.phase !== "focused") return state;
  if (pointerId !== undefined && !ownsGesture(state, pointerId)) {
    return state;
  }
  return { ...state, gesture: { kind: "none" }, modelPreview: undefined };
}

/**
 * 结束 model 手势并返回最终 preview（供提交判定）。非 model 手势或指针不匹配时 preview 为 null。
 *
 * change: add-model-focus-editing，任务 3.1：释放点在有净变化且会话可写时提交一次完整
 * placement patch；调用方据此比较 origin/final。
 */
export function finishModelGesture(
  state: ModelFocusState,
  pointerId: number
): { state: ModelFocusState; origin: PlacementDraft | null; preview: PlacementDraft | null } {
  if (state.phase !== "focused") return { state, origin: null, preview: null };
  const gesture = state.gesture;
  if (gesture.kind !== "model" || gesture.pointerId !== pointerId) {
    return { state, origin: null, preview: null };
  }
  return {
    state: { ...state, gesture: { kind: "none" }, modelPreview: undefined },
    origin: gesture.drag.origin,
    preview: state.modelPreview ?? gesture.drag.origin
  };
}

/** 最远缩放距离为模型包围球半径的 40 倍，既能拉远看全场景，又避免模型缩成不可辨认的小点。 */
export const FOCUS_ZOOM_OUT_RADIUS_MULTIPLIER = 40;

function clampZoomDistance(distance: number, radius: number): number {
  const safeRadius = Number.isFinite(radius) && radius > 0 ? radius : 1;
  return clampDistance(Math.min(distance, safeRadius * FOCUS_ZOOM_OUT_RADIUS_MULTIPLIER), radius);
}

/** 滚轮：未按右键时 dolly；按右键时调整 flySpeed。 */
export function wheelZoom(
  state: ModelFocusState,
  deltaY: number,
  options: { rightDown: boolean }
): ModelFocusState {
  if (state.phase !== "focused") return state;
  const steps = deltaY === 0 ? 0 : deltaY > 0 ? 1 : -1;
  if (options.rightDown) {
    // 向前滚（deltaY < 0）加速。
    const factor = steps < 0 ? 1.15 : 1 / 1.15;
    return { ...state, camera: { ...state.camera, flySpeed: clampFlySpeed(state.camera.flySpeed * factor) } };
  }
  const factor = steps > 0 ? MODEL_FOCUS_DOLLY_OUT : MODEL_FOCUS_DOLLY_IN;
  return {
    ...state,
    camera: { ...state.camera, distance: clampZoomDistance(state.camera.distance * factor, state.radius) }
  };
}

/**
 * 连续缩放主观察相机（change: 对齐 xyflow-bevy 聚焦导航）。
 *
 * `factor > 1` 表示放大（相机靠近 target，distance 减小）。用于触控板捏合 /
 * Chromium ctrl-wheel 捏合 / Safari `GestureEvent`：这些手势给出的是连续比例而非离散步长。
 * 非有限或非正 factor 视为无操作。只影响相机 `distance`，不写规范数据。
 */
export function zoomFocusByFactor(state: ModelFocusState, factor: number): ModelFocusState {
  if (state.phase !== "focused") return state;
  if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return state;
  const distance = clampZoomDistance(state.camera.distance / factor, state.radius);
  if (distance === state.camera.distance) return state;
  return { ...state, camera: { ...state.camera, distance } };
}

/** 每帧键盘飞行：`held` 为规范化的轴输入（-1..1）。 */
export function keyboardFly(
  state: ModelFocusState,
  held: { forward: number; right: number; up: number },
  modifiers: { fast: boolean; slow: boolean },
  deltaSeconds: number
): ModelFocusState {
  if (state.phase !== "focused") return state;
  const speedScale = modifiers.fast ? MODEL_FOCUS_SPEED_FAST : modifiers.slow ? MODEL_FOCUS_SPEED_SLOW : 1;
  const step = state.camera.flySpeed * speedScale * deltaSeconds;
  if (held.forward === 0 && held.right === 0 && held.up === 0) return state;
  const { forward, right, up } = cameraBasis(state.camera);
  const target: Vec3 = [
    state.camera.target[0] + (forward[0] * held.forward + right[0] * held.right + up[0] * held.up) * step,
    state.camera.target[1] + (forward[1] * held.forward + right[1] * held.right + up[1] * held.up) * step,
    state.camera.target[2] + (forward[2] * held.forward + right[2] * held.right + up[2] * held.up) * step
  ];
  return { ...state, camera: { ...state.camera, target } };
}

/** 相机前/右/上基向量（世界空间）。 */
function cameraBasis(camera: ModelFocusCamera): { forward: Vec3; right: Vec3; up: Vec3 } {
  const cp = Math.cos(camera.pitch);
  const forward: Vec3 = [-Math.sin(camera.yaw) * cp, Math.sin(camera.pitch), -Math.cos(camera.yaw) * cp];
  const right: Vec3 = [Math.cos(camera.yaw), 0, -Math.sin(camera.yaw)];
  const up: Vec3 = [0, 1, 0];
  return { forward, right, up };
}

/** 投影为 `CanvasRenderScene.modelFocus`；非聚焦返回 null。 */
export function toProjection(state: ModelFocusState): ModelFocusProjection | null {
  if (state.phase !== "focused") return null;
  return {
    version: MODEL_FOCUS_VERSION,
    nodeId: state.nodeId,
    target: [...state.camera.target],
    yaw: state.camera.yaw,
    pitch: state.camera.pitch,
    distance: state.camera.distance,
    fov: MODEL_FOCUS_FOV,
    radius: state.radius
  };
}

function isValidTarget(target: Vec3): boolean {
  return target.length === 3 && target.every((value) => Number.isFinite(value));
}
