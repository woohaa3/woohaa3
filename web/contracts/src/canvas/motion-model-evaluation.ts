/** 共享模型动作采样；浏览器检查与原生拍摄烘焙均使用这份语义。 */
import { axisAngle, quatMul, type Vec3 } from "./model-transform.js";
import { identityModelDelta, type ModelMotionDelta, type ModelTrack } from "./motion-ir.js";
import { modelMotionProperty, type KeyframeMotion } from "./motion-keyframes.js";

const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } satisfies Record<string, Vec3>;

export function evaluateModelTrack(track: ModelTrack, time: number): ModelMotionDelta | null {
  if (time < track.startTime) return null;
  const now = Math.min(time, track.endTime);
  const motion = track.motion;
  const delta = identityModelDelta();
  if (motion.kind === "keyframes") {
    const value = sampleKeyframes(motion, now);
    if (motion.property === "position") delta.translation = value;
    else if (motion.property === "scale") delta.scale = value;
    else delta.rotation = quatMul(quatMul(axisAngle(AXES.y, value[1]), axisAngle(AXES.x, value[0])), axisAngle(AXES.z, value[2]));
    return delta;
  }
  const axis = motion.axis === "x" ? 0 : motion.axis === "z" ? 2 : 1;
  if (motion.kind === "rotate") delta.rotation = axisAngle(AXES[motion.axis], (now - track.startTime) * motion.speed);
  else if (motion.kind === "move") {
    const [min, max] = motion.range;
    const span = max - min;
    const local = (now - track.startTime) * motion.speed;
    delta.translation[axis] = span > 0 ? min + ((local % span) + span) % span : min;
  } else {
    const wave = Math.sin((now - track.startTime) * motion.speed + motion.phase) * motion.amplitude;
    if (motion.mode === "rotation") delta.rotation = axisAngle(AXES[motion.axis], wave);
    else if (motion.mode === "scale") delta.scale[axis] = 1 + wave;
    else delta.translation[axis] = wave;
  }
  return delta;
}

/** 后开始的同属性片段接管；其他属性保留，不被 identity 分量覆盖。 */
export function mergeModelTrackDelta(base: ModelMotionDelta, next: ModelMotionDelta, track: ModelTrack): ModelMotionDelta {
  switch (modelMotionProperty(track.motion)) {
    case "position": return { ...base, translation: next.translation };
    case "rotation": return { ...base, rotation: next.rotation };
    case "scale": return { ...base, scale: next.scale };
  }
}

function sampleKeyframes(motion: KeyframeMotion, now: number): Vec3 {
  const frames = motion.frames;
  if (now >= frames[frames.length - 1]!.time) return [...frames[frames.length - 1]!.value];
  const index = frames.findIndex((point, i) => i > 0 && now < point.time);
  const a = frames[Math.max(0, index - 1)]!;
  const b = frames[Math.max(1, index)]!;
  const progress = Math.max(0, Math.min(1, (now - a.time) / (b.time - a.time)));
  const t = a.easing === "smoothstep" ? progress * progress * (3 - 2 * progress) : progress;
  return a.value.map((v, i) => v + (b.value[i]! - v) * t) as Vec3;
}
