/** 连续模型关键帧：一份几何的变换通道，时间使用对象局部秒数。 */
import type { Vec3 } from "./model-transform.js";
import type { ModelMotion, MotionEasing } from "./motion-ir.js";

export const MOTION_MAX_KEYFRAMES_PER_TRACK = 1024;
export type ModelTrackProperty = "position" | "rotation" | "scale";
export type ModelKeyframe = { time: number; value: Vec3; easing: MotionEasing };
export type KeyframeMotion = { kind: "keyframes"; property: ModelTrackProperty; frames: ModelKeyframe[] };

export function modelMotionProperty(motion: ModelMotion): ModelTrackProperty {
  if (motion.kind === "keyframes") return motion.property;
  return motion.kind === "rotate" ? "rotation" : motion.kind === "move" ? "position" : motion.mode;
}

export function readKeyframeMotion(raw: Record<string, unknown>, start: number, end: number):
  { ok: true; value: KeyframeMotion } | { ok: false; code: "invalid-motion"; message: string } {
  const reject = (message: string) => ({ ok: false as const, code: "invalid-motion" as const, message });
  const property = raw.property;
  if (property !== "position" && property !== "rotation" && property !== "scale") return reject("关键帧 property 必须是 position/rotation/scale");
  const easing = raw.easing ?? "linear";
  if (easing !== "linear" && easing !== "smoothstep") return reject("关键帧 easing 必须是 linear/smoothstep");
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
    if (!Array.isArray(value) || value.length !== 3 || !value.every(v => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1_000_000)) return reject("关键帧 value 必须是有限三维坐标");
    if (property === "scale" && value.some(v => v < 0)) return reject("关键帧缩放不能为负数");
    if (curve !== "linear" && curve !== "smoothstep") return reject("关键帧 easing 必须是 linear/smoothstep");
    frames.push({ time, value: [...value] as Vec3, easing: curve });
  }
  if (frames[0]!.time !== start || frames[frames.length - 1]!.time !== end) return reject("首末关键帧时间必须等于 startTime/endTime");
  return { ok: true, value: { kind: "keyframes", property, frames } };
}
