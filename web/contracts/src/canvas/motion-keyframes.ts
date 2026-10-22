/** 连续模型关键帧：一份几何的变换通道，时间使用对象局部秒数。 */
import type { Vec3 } from "./model-transform.js";
import type { ModelMotion, MotionEasing } from "./motion-ir.js";

export const MOTION_MAX_KEYFRAMES_PER_TRACK = 1024;
/**
 * 模型轨道属性。
 *
 * `opacity` 为透明度乘数（change: 2026-10-19-extend-film-set-for-motion-graphics，D1）：
 * 只有 keyframes/tween 可以使用，值是 `0..=1` 的标量而不是三维向量。
 */
export type ModelTrackProperty = "position" | "rotation" | "scale" | "opacity";
export type ModelKeyframe = { time: number; value: Vec3 | number; easing: MotionEasing };
export type KeyframeMotion = { kind: "keyframes"; property: ModelTrackProperty; frames: ModelKeyframe[] };

/** 受支持的关键帧属性集合（唯一定义，validator 与求值共用）。 */
export const MODEL_TRACK_PROPERTIES = ["position", "rotation", "scale", "opacity"] as const;

/** 受支持缓动集合（唯一定义；TS 与 Rust 取值必须一致）。 */
export const MOTION_EASINGS = ["linear", "smoothstep", "easeIn", "easeOut", "easeInOut"] as const;

export function isModelTrackProperty(value: unknown): value is ModelTrackProperty {
  return typeof value === "string" && (MODEL_TRACK_PROPERTIES as readonly string[]).includes(value);
}

export function isMotionEasing(value: unknown): value is MotionEasing {
  return typeof value === "string" && (MOTION_EASINGS as readonly string[]).includes(value);
}

/** 标量通道属性（值不是三维向量）。 */
export function isScalarTrackProperty(property: ModelTrackProperty): boolean {
  return property === "opacity";
}

export function modelMotionProperty(motion: ModelMotion): ModelTrackProperty {
  if (motion.kind === "keyframes") return motion.property;
  return motion.kind === "rotate" ? "rotation" : motion.kind === "move" ? "position" : motion.mode;
}

export function readKeyframeMotion(raw: Record<string, unknown>, start: number, end: number):
  { ok: true; value: KeyframeMotion } | { ok: false; code: "invalid-motion"; message: string } {
  const reject = (message: string) => ({ ok: false as const, code: "invalid-motion" as const, message });
  const property = raw.property;
  if (!isModelTrackProperty(property)) return reject("关键帧 property 必须是 position/rotation/scale/opacity");
  const easing = raw.easing ?? "linear";
  if (!isMotionEasing(easing)) return reject("关键帧 easing 必须是 linear/smoothstep/easeIn/easeOut/easeInOut");
  const input = raw.kind === "tween" ? [{ time: start, value: raw.from }, { time: end, value: raw.to }] : raw.frames;
  if (!Array.isArray(input) || input.length < 2 || input.length > MOTION_MAX_KEYFRAMES_PER_TRACK) {
    return reject(`关键帧必须有 2–${MOTION_MAX_KEYFRAMES_PER_TRACK} 个点`);
  }
  const frames: ModelKeyframe[] = [];
  for (const point of input) {
    if (!point || typeof point !== "object") return reject("关键帧必须是 { time, value, easing? }");
    const { time, value } = point as Record<string, unknown>;
    const curve = point.easing ?? easing;
    if (typeof time !== "number" || !Number.isFinite(time) || time < start || time > end || (frames.length > 0 && time <= frames[frames.length - 1]!.time)) {
      return reject("关键帧时间必须严格递增且位于轨道区间内");
    }
    if (isScalarTrackProperty(property)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        return reject("opacity 关键帧 value 必须是 0–1 的数字");
      }
    } else {
      if (!Array.isArray(value) || value.length !== 3 || !value.every(v => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1_000_000)) return reject("关键帧 value 必须是有限三维坐标");
      if (property === "scale" && value.some(v => v < 0)) return reject("关键帧缩放不能为负数");
    }
    if (!isMotionEasing(curve)) return reject("关键帧 easing 必须是 linear/smoothstep/easeIn/easeOut/easeInOut");
    frames.push({ time, value: isScalarTrackProperty(property) ? (value as number) : ([...value as number[]] as Vec3), easing: curve });
  }
  if (frames[0]!.time !== start || frames[frames.length - 1]!.time !== end) return reject("首末关键帧时间必须等于 startTime/endTime");
  return { ok: true, value: { kind: "keyframes", property, frames } };
}
