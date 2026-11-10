/**
 * `woohaa-motion-ir-v1` 运动 IR 契约、validator 与确定性求值器
 * （change: 2026-10-05-bind-model-animation-to-shots，任务 1.4 / 1.5）。
 *
 * 运动脚本执行后生成受控 `MotionIr`：一组镜头轨道与模型轨道，共用同一时间线。IR 只是
 * **运行时 DTO**，不写回 canonical nodeData；播放时由执行器按时间求值，不每帧重跑脚本。
 *
 * 关键不变式（design「运动的执行结果」）：
 * - 所有轨道满足 `0 <= startTime < endTime <= duration`；
 * - 同一镜头属性的轨道区间不得重叠（相接允许，后一轨道在开始时刻接管）；
 * - 同一模型目标的同一属性不得重叠；不同属性与相接片段允许；
 * - 数值必须有限；相机角度与 rotate.speed 使用弧度/弧度每秒。
 */
import {
  clampCameraElevation,
  DEFAULT_CAMERA_ASPECT,
  type CameraAspect
} from "./camera-aspect.js";
import {
  isMotionEasing,
  modelMotionProperty,
  readKeyframeMotion,
  type KeyframeMotion
} from "./motion-keyframes.js";
import { evaluateModelTrack, mergeModelTrackDelta } from "./motion-model-evaluation.js";
export * from "./motion-keyframes.js";
import type { Quat, Vec3 } from "./model-transform.js";

export const MOTION_IR_VERSION = "woohaa-motion-ir-v1" as const;
export type MotionIrVersion = typeof MOTION_IR_VERSION;

/** 运动预算（design「实施边界与验收」；JavaScript 与 Rust 使用同样约束）。 */
export const MOTION_MAX_CAMERA_TRACKS = 256;
export const MOTION_MAX_MODEL_TRACKS = 256;
export const MOTION_MAX_TRACKS = 512;
export const MOTION_MAX_DURATION_SECONDS = 3600;

/** 坐标 / 位移 / 振幅的有限上限（与 Scene IR 同量级）。 */
export const MOTION_COORD_LIMIT = 1_000_000;

/** 镜头可动画属性。 */
export const CAMERA_TRACK_PROPERTIES = [
  "azimuth",
  "elevation",
  "distance",
  "focusOffset.x",
  "focusOffset.y",
  "focusOffset.z"
] as const;
export type CameraTrackProperty = (typeof CAMERA_TRACK_PROPERTIES)[number];

export type MotionEasing = "linear" | "smoothstep" | "easeIn" | "easeOut" | "easeInOut";

export type Axis3 = "x" | "y" | "z";
export type OscillateMode = "position" | "rotation" | "scale";

/** 镜头轨道：在 [startTime,endTime] 内把某属性从 from 插值到 to。 */
export type CameraTrack = {
  id: string;
  property: CameraTrackProperty;
  startTime: number;
  endTime: number;
  from: number;
  to: number;
  easing: MotionEasing;
};

/** 模型轨道动作（闭合判别联合）。 */
export type ModelMotion =
  | KeyframeMotion
  | { kind: "rotate"; axis: Axis3; speed: number }
  | { kind: "move"; axis: Axis3; speed: number; range: [number, number] }
  | { kind: "oscillate"; axis: Axis3; mode: OscillateMode; speed: number; amplitude: number; phase: number };

/** 模型轨道：在 [startTime,endTime] 内作用于稳定 `targetId`。 */
export type ModelTrack = {
  id: string;
  targetId: string;
  startTime: number;
  endTime: number;
  motion: ModelMotion;
};

export type MotionIr = {
  version: MotionIrVersion;
  cameraMotion: CameraTrack[];
  modelMotion: ModelTrack[];
};

/** 运动校验失败码。 */
export type MotionIrErrorCode =
  | "not-object"
  | "version-mismatch"
  | "too-many-tracks"
  | "invalid-track"
  | "invalid-time-range"
  | "track-out-of-range"
  | "overlapping-camera-track"
  | "overlapping-model-track"
  | "unknown-target"
  | "invalid-motion";

export type MotionIrValidation =
  | { ok: true; ir: MotionIr }
  | { ok: false; code: MotionIrErrorCode; message: string };

/** 视口/相机的初始镜头状态（方位角、仰角、距离、注视点偏移）。 */
export type InitialCameraState = {
  azimuth: number;
  elevation: number;
  distance: number;
  focusOffset: { x: number; y: number; z: number };
};

export type MotionEvalContext = {
  /** 时间线时长（秒）；用于推导默认 endTime。 */
  duration: number;
  /** 初始镜头（第 0 秒）。 */
  initialCamera: InitialCameraState;
  /** 校验过、允许作为模型轨道目标的稳定部件 ID。 */
  partIds: ReadonlySet<string>;
};

export type MotionEvalResult =
  | {
      ok: true;
      camera: InitialCameraState;
      /** 每个受影响部件在当前时刻的**增量** transform（相对基础姿态）。 */
      model: Map<string, ModelMotionDelta>;
    }
  | { ok: false; code: MotionIrErrorCode; message: string };

/** 部位当前增量：旋转乘在基础旋转之后，平移/缩放叠加在基础值上，opacity 为透明度乘数。 */
export type ModelMotionDelta = {
  rotation: Quat;
  translation: Vec3;
  scale: Vec3;
  /** 透明度乘数（0..1，缺省 1）；与材质静态透明度及所属对象透明度相乘。 */
  opacity: number;
};

const OSCILLATE_MODES: ReadonlySet<string> = new Set(["position", "rotation", "scale"]);

/** 同一镜头属性可动画的最小时间粒度（相接边界容差）。 */
const TIME_EPSILON = 1e-9;

export function identityModelDelta(): ModelMotionDelta {
  return { rotation: [0, 0, 0, 1], translation: [0, 0, 0], scale: [1, 1, 1], opacity: 1 };
}

/**
 * 校验不受信任的 `MotionIr`。
 *
 * 补齐默认值（axis=mode=phase=easing 等）、检查时间区间、重叠与目标引用，返回确定性 IR。
 * 任一非法项整条拒绝，绝不静默丢弃部分轨道。
 */
export function validateMotionIr(
  input: unknown,
  context: { duration: number; partIds?: ReadonlySet<string> }
): MotionIrValidation {
  if (!isRecord(input)) return fail("not-object", "Motion IR 必须是对象");
  if (input.version !== MOTION_IR_VERSION) {
    return fail("version-mismatch", `未知 Motion IR 版本 ${String(input.version)}`);
  }
  const duration = readFinite(context.duration);
  if (duration === null || duration < 0 || duration > MOTION_MAX_DURATION_SECONDS) {
    return fail("invalid-time-range", `时间线时长非法：${String(context.duration)}`);
  }
  const rawCamera = input.cameraMotion ?? [];
  const rawModel = input.modelMotion ?? [];
  if (!Array.isArray(rawCamera) || !Array.isArray(rawModel)) {
    return fail("invalid-track", "cameraMotion / modelMotion 必须是数组");
  }
  if (rawCamera.length > MOTION_MAX_CAMERA_TRACKS) {
    return fail("too-many-tracks", `镜头轨道 ${rawCamera.length} 超过上限 ${MOTION_MAX_CAMERA_TRACKS}`);
  }
  if (rawModel.length > MOTION_MAX_MODEL_TRACKS) {
    return fail("too-many-tracks", `模型轨道 ${rawModel.length} 超过上限 ${MOTION_MAX_MODEL_TRACKS}`);
  }
  if (rawCamera.length + rawModel.length > MOTION_MAX_TRACKS) {
    return fail("too-many-tracks", `运动轨道总数超过上限 ${MOTION_MAX_TRACKS}`);
  }

  const cameraMotion: CameraTrack[] = [];
  const intervals = new Map<CameraTrackProperty, Array<[number, number]>>();
  for (let index = 0; index < rawCamera.length; index += 1) {
    const track = readCameraTrack(rawCamera[index], index, duration);
    if (!track.ok) return track;
    const value = track.value;
    const existing = intervals.get(value.property) ?? [];
    for (const [start, end] of existing) {
      // 相接（end == start）允许；真正重叠拒绝。
      if (value.startTime < end - TIME_EPSILON && value.endTime > start + TIME_EPSILON) {
        return fail("overlapping-camera-track", `镜头属性 ${value.property} 的轨道区间重叠`);
      }
    }
    existing.push([value.startTime, value.endTime]);
    intervals.set(value.property, existing);
    cameraMotion.push(value);
  }

  const modelMotion: ModelTrack[] = [];
  const modelIntervals = new Map<string, Array<[number, number]>>();
  for (let index = 0; index < rawModel.length; index += 1) {
    const track = readModelTrack(rawModel[index], index, duration);
    if (!track.ok) return track;
    const value = track.value;
    const channel = `${value.targetId}:${modelMotionProperty(value.motion)}`;
    const ranges = modelIntervals.get(channel) ?? [];
    if (ranges.some(([start, end]) => value.startTime < end - TIME_EPSILON && value.endTime > start + TIME_EPSILON)) {
      return fail("overlapping-model-track", `模型部件 ${value.targetId} 的 ${modelMotionProperty(value.motion)} 轨道区间重叠；可用相接片段或 keyframes`);
    }
    ranges.push([value.startTime, value.endTime]);
    modelIntervals.set(channel, ranges);
    if (context.partIds && !context.partIds.has(value.targetId)) {
      return fail("unknown-target", `模型部件 ${value.targetId} 不存在`);
    }
    modelMotion.push(value);
  }

  return { ok: true, ir: { version: MOTION_IR_VERSION, cameraMotion, modelMotion } };
}

function readCameraTrack(
  raw: unknown,
  index: number,
  duration: number
): { ok: true; value: CameraTrack } | { ok: false; code: MotionIrErrorCode; message: string } {
  if (!isRecord(raw)) return fail("invalid-track", `第 ${index} 条镜头轨道不是对象`);
  const id = readId(raw.id);
  if (id === null) return fail("invalid-track", `第 ${index} 条镜头轨道缺少合法 id`);
  const property = raw.property;
  if (typeof property !== "string" || !CAMERA_TRACK_PROPERTIES.includes(property as CameraTrackProperty)) {
    return fail("invalid-track", `镜头轨道 ${id} 的 property 非法`);
  }
  const time = readTimeRange(raw, id, duration);
  if (!time.ok) return time;
  const from = readFinite(raw.from);
  const to = readFinite(raw.to);
  if (from === null || to === null) return fail("invalid-track", `镜头轨道 ${id} 的 from/to 非法`);
  const easing = raw.easing ?? "linear";
  if (!isMotionEasing(easing)) {
    return fail("invalid-track", `镜头轨道 ${id} 的 easing 非法`);
  }
  return {
    ok: true,
    value: {
      id,
      property: property as CameraTrackProperty,
      startTime: time.start,
      endTime: time.end,
      from,
      to,
      easing: easing as MotionEasing
    }
  };
}

function readModelTrack(
  raw: unknown,
  index: number,
  duration: number
): { ok: true; value: ModelTrack } | { ok: false; code: MotionIrErrorCode; message: string } {
  if (!isRecord(raw)) return fail("invalid-track", `第 ${index} 条模型轨道不是对象`);
  const id = readId(raw.id);
  if (id === null) return fail("invalid-track", `第 ${index} 条模型轨道缺少合法 id`);
  const targetId = readId(raw.targetId);
  if (targetId === null) return fail("invalid-track", `模型轨道 ${id} 缺少稳定 targetId`);
  const frames = isRecord(raw.motion) && raw.motion.kind === "keyframes" && Array.isArray(raw.motion.frames) ? raw.motion.frames : [];
  const time = readTimeRange({ ...raw, startTime: raw.startTime ?? frames[0]?.time, endTime: raw.endTime ?? frames[frames.length - 1]?.time }, id, duration);
  if (!time.ok) return time;
  const motion = readModelMotion(raw.motion, id, time.start, time.end);
  if (!motion.ok) return motion;
  return { ok: true, value: { id, targetId, startTime: time.start, endTime: time.end, motion: motion.value } };
}

function readModelMotion(
  raw: unknown,
  trackId: string,
  start: number,
  end: number
): { ok: true; value: ModelMotion } | { ok: false; code: MotionIrErrorCode; message: string } {
  if (!isRecord(raw)) return fail("invalid-motion", `模型轨道 ${trackId} 缺少 motion`);
  const kind = raw.kind;
  if (kind === "tween" || kind === "keyframes") return readKeyframeMotion(raw, start, end);
  const axis = raw.axis ?? "y";
  if (axis !== "x" && axis !== "y" && axis !== "z") {
    return fail("invalid-motion", `模型轨道 ${trackId} 的 axis 非法`);
  }
  if (kind === "rotate") {
    const speed = readFinite(raw.speed);
    if (speed === null) return fail("invalid-motion", `模型轨道 ${trackId} 的 rotate.speed 必填且有限`);
    return { ok: true, value: { kind: "rotate", axis, speed } };
  }
  if (kind === "move") {
    const speed = readFinite(raw.speed);
    if (speed === null) return fail("invalid-motion", `模型轨道 ${trackId} 的 move.speed 必填且有限`);
    const range = raw.range;
    if (!Array.isArray(range) || range.length !== 2) {
      return fail("invalid-motion", `模型轨道 ${trackId} 的 move.range 必填且为 [min,max]`);
    }
    const min = readFinite(range[0]);
    const max = readFinite(range[1]);
    if (min === null || max === null) return fail("invalid-motion", `模型轨道 ${trackId} 的 move.range 非法`);
    return { ok: true, value: { kind: "move", axis, speed, range: [min, max] } };
  }
  if (kind === "oscillate") {
    const mode = raw.mode ?? "position";
    if (typeof mode !== "string" || !OSCILLATE_MODES.has(mode)) {
      return fail("invalid-motion", `模型轨道 ${trackId} 的 oscillate.mode 非法`);
    }
    const speed = readFinite(raw.speed);
    if (speed === null) return fail("invalid-motion", `模型轨道 ${trackId} 的 oscillate.speed 必填且有限`);
    const amplitude = raw.amplitude === undefined ? null : readFinite(raw.amplitude);
    if (amplitude === null) return fail("invalid-motion", `模型轨道 ${trackId} 的 oscillate.amplitude 必填且有限`);
    const phase = raw.phase === undefined ? 0 : readFinite(raw.phase);
    if (phase === null) return fail("invalid-motion", `模型轨道 ${trackId} 的 oscillate.phase 非法`);
    return {
      ok: true,
      value: { kind: "oscillate", axis, mode: mode as OscillateMode, speed, amplitude, phase }
    };
  }
  return fail("invalid-motion", `模型轨道 ${trackId} 的 kind 必须是 rotate/move/oscillate/tween/keyframes`);
}

/**
 * 在 `time` 秒对运动 IR 求值（确定性纯函数）。
 *
 * - 镜头从 `initialCamera` 开始；已结束轨道保持 `to`，未开始轨道不生效；同属性后一轨道在
 *   开始时刻接管（相接边界连续）。
 * - 模型轨道按目标与属性合成；开始前保持基础姿态，结束后保持末态。
 * - 目标不存在（`partIds` 已给定）时返回稳定错误而不是部分结果。
 */
export function evaluateMotionIr(
  ir: MotionIr,
  time: number,
  context: MotionEvalContext
): MotionEvalResult {
  const now = Number.isFinite(time) ? Math.max(0, Math.min(time, context.duration)) : 0;
  const camera = cloneCamera(context.initialCamera);

  for (const track of [...ir.cameraMotion].sort((a,b) => a.startTime - b.startTime)) {
    if (now < track.startTime) continue;
    const value = now >= track.endTime
      ? track.to
      : track.from + (track.to - track.from) * easingProgress(track.easing, (now - track.startTime) / (track.endTime - track.startTime));
    applyCameraProperty(camera, track.property, value);
  }

  const model = new Map<string, ModelMotionDelta>();
  for (const track of [...ir.modelMotion].sort((a,b) => a.startTime - b.startTime)) {
    if (context.partIds && !context.partIds.has(track.targetId)) {
      return { ok: false, code: "unknown-target", message: `模型部件 ${track.targetId} 不存在` };
    }
    const delta = evaluateModelTrack(track, now);
    if (delta) model.set(track.targetId, mergeModelTrackDelta(model.get(track.targetId) ?? identityModelDelta(), delta, track));
  }
  return { ok: true, camera, model };
}

function applyCameraProperty(camera: InitialCameraState, property: CameraTrackProperty, value: number): void {
  switch (property) {
    case "azimuth":
      camera.azimuth = value;
      return;
    case "elevation":
      camera.elevation = clampCameraElevation(value);
      return;
    case "distance":
      camera.distance = value;
      return;
    case "focusOffset.x":
      camera.focusOffset.x = value;
      return;
    case "focusOffset.y":
      camera.focusOffset.y = value;
      return;
    case "focusOffset.z":
      camera.focusOffset.z = value;
      return;
  }
}

/** 缓动进度：输入按 [0,1] 钳制；边界值精确为 0 与 1（与 Rust `easing_progress` 同一公式）。 */
export function easingProgress(easing: MotionEasing, t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  const inverse = 1 - clamped;
  switch (easing) {
    case "smoothstep":
      return clamped * clamped * (3 - 2 * clamped);
    case "easeIn":
      // t³：起步慢、末尾快。
      return clamped * clamped * clamped;
    case "easeOut":
      // 1-(1-t)³：起步快、末尾减速（「弹出后减速」）。
      return 1 - inverse * inverse * inverse;
    case "easeInOut":
      // 分段三次：前半加速、后半减速；边界精确为 0 与 1。
      return clamped < 0.5
        ? 4 * clamped * clamped * clamped
        : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
    case "linear":
    default:
      return clamped;
  }
}

/** 初始镜头画幅读取（与模型镜头集合同一套受支持值）。 */
export function readInitialCameraAspect(value: unknown): CameraAspect {
  return typeof value === "string" && value.includes(":")
    ? (value as CameraAspect)
    : DEFAULT_CAMERA_ASPECT;
}

function cloneCamera(camera: InitialCameraState): InitialCameraState {
  return {
    azimuth: camera.azimuth,
    elevation: camera.elevation,
    distance: camera.distance,
    focusOffset: { ...camera.focusOffset }
  };
}

// ── 读取工具 ─────────────────────────────────────────────────────────────────

function readTimeRange(
  raw: Record<string, unknown>,
  id: string,
  duration: number
): { ok: true; start: number; end: number } | { ok: false; code: MotionIrErrorCode; message: string } {
  const start = raw.startTime === undefined ? 0 : readFinite(raw.startTime);
  const end = raw.endTime === undefined ? duration : readFinite(raw.endTime);
  if (start === null || end === null) return fail("invalid-time-range", `轨道 ${id} 的 startTime/endTime 非法`);
  if (!(start < end)) return fail("invalid-time-range", `轨道 ${id} 必须满足 startTime < endTime`);
  if (start < 0 || end > duration + TIME_EPSILON) {
    return fail("track-out-of-range", `轨道 ${id} 的区间超出 [0, ${duration}]`);
  }
  return { ok: true, start, end };
}

function readFinite(input: unknown): number | null {
  if (typeof input !== "number" || !Number.isFinite(input)) return null;
  if (Math.abs(input) > MOTION_COORD_LIMIT) return null;
  return input;
}

function readId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  return value.length > 0 ? value : null;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function fail(code: MotionIrErrorCode, message: string): { ok: false; code: MotionIrErrorCode; message: string } {
  return { ok: false, code, message };
}
