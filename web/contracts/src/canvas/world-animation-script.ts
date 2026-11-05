/**
 * 导演区统一动画脚本（`woohaa-world-animation-js-v2`）。
 *
 * 导演区不再使用整对象关键帧：动画由一个 JS 脚本声明，脚本只通过注入的 `motion` 对象
 * 描述**导演区内部部件**——共享世界实例与镜头——的运动。脚本执行一次编译成受控 IR，
 * 播放时按时间确定性求值，不每帧执行 JS，也不逐帧写规范文档。
 *
 * **位置轨道以导演区的 `animationOrigin` 为原点**：`from`/`to` 的 u/v 是相对偏移，
 * h 仍是绝对高度。求值本身只读；导演区移动时无需改写轨道。
 *
 * 目标必须是导演区完整包含的实例/镜头；权限与占用由权威写入时校验。
 */
import { fnv1a64Hex } from "./content-hash.js";
import { easingProgress } from "./motion-ir.js";
import { quatFromEulerYXZDegrees } from "./model-transform.js";
import type { GroundPoint, WorldPoint, WorldRotation } from "./shared-world.js";

export const WORLD_ANIMATION_SCRIPT_VERSION = "woohaa-world-animation-js-v2" as const;
export const WORLD_ANIMATION_SCRIPT_LANGUAGE = "javascript" as const;
export const WORLD_ANIMATION_IR_VERSION = "woohaa-world-animation-ir-v1" as const;
export const WORLD_ANIMATION_MAX_TRACKS = 256;
export const WORLD_ANIMATION_MAX_DURATION_SECONDS = 3600;

export type WorldAnimationEasing = "linear" | "smoothstep" | "easeIn" | "easeOut" | "easeInOut";
export const WORLD_ANIMATION_EASINGS: readonly WorldAnimationEasing[] = ["linear", "smoothstep", "easeIn", "easeOut", "easeInOut"];

export type WorldAnimationScript = {
  script: string;
  scriptLanguage: typeof WORLD_ANIMATION_SCRIPT_LANGUAGE;
  scriptVersion: typeof WORLD_ANIMATION_SCRIPT_VERSION;
  revision: number;
  sourceHash: string;
  duration: number;
  loop: boolean;
};

export type WorldInstanceMotionProperty = "position" | "rotation" | "scale";
export type WorldCameraMotionProperty = "position" | "rotation" | "zoom";

export type WorldInstanceTrack = {
  targetId: string;
  property: WorldInstanceMotionProperty;
  startTime: number;
  endTime: number;
  from: number[];
  to: number[];
  easing: WorldAnimationEasing;
};

export type WorldCameraTrack = {
  targetId: string;
  property: WorldCameraMotionProperty;
  startTime: number;
  endTime: number;
  from: number[];
  to: number[];
  easing: WorldAnimationEasing;
};

export type WorldAnimationIr = {
  version: typeof WORLD_ANIMATION_IR_VERSION;
  duration: number;
  loop: boolean;
  instanceTracks: WorldInstanceTrack[];
  cameraTracks: WorldCameraTrack[];
};

export type WorldAnimationScriptFailure = {
  ok: false;
  stage: "compile" | "execute" | "determinism" | "invalid";
  code: string;
  message: string;
};
export type WorldAnimationScriptSuccess = { ok: true; ir: WorldAnimationIr; json: string };
export type WorldAnimationScriptResult = WorldAnimationScriptSuccess | WorldAnimationScriptFailure;

/** 由源码与播放参数创建可持久化的动画脚本定义。 */
export function createWorldAnimationScript(input: {
  script: string;
  duration: number;
  loop: boolean;
  revision?: number;
}): WorldAnimationScript {
  return {
    script: input.script,
    scriptLanguage: WORLD_ANIMATION_SCRIPT_LANGUAGE,
    scriptVersion: WORLD_ANIMATION_SCRIPT_VERSION,
    revision: Number.isInteger(input.revision) && (input.revision ?? 0) > 0 ? input.revision! : 1,
    sourceHash: fnv1a64Hex(input.script),
    duration: input.duration,
    loop: input.loop
  };
}

const WORLD_ANIMATION_SCRIPT_KEYS = [
  "script", "scriptLanguage", "scriptVersion", "revision", "sourceHash", "duration", "loop"
] as const;

/** 严格解码持久化的动画脚本定义；unknown 版本或字段整体拒绝。 */
export function decodeWorldAnimationScript(
  input: unknown
): { ok: true; value: WorldAnimationScript } | { ok: false; code: "invalid-data"; message: string } {
  if (!isRecord(input) || !Object.keys(input).every(key => (WORLD_ANIMATION_SCRIPT_KEYS as readonly string[]).includes(key))) {
    return { ok: false, code: "invalid-data", message: "动画脚本定义无效" };
  }
  const script = input.script;
  const scriptLanguage = input.scriptLanguage;
  const scriptVersion = input.scriptVersion;
  const revision = input.revision;
  const sourceHash = input.sourceHash;
  const duration = input.duration;
  const loop = input.loop;
  if (
    typeof script !== "string" || script.trim() === ""
    || scriptLanguage !== WORLD_ANIMATION_SCRIPT_LANGUAGE
    || scriptVersion !== WORLD_ANIMATION_SCRIPT_VERSION
    || typeof sourceHash !== "string" || sourceHash.trim() === ""
    || !Number.isInteger(revision) || (revision as number) < 1
    || typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0 || duration > WORLD_ANIMATION_MAX_DURATION_SECONDS
    || typeof loop !== "boolean"
  ) {
    return { ok: false, code: "invalid-data", message: "动画脚本定义无效" };
  }
  return {
    ok: true,
    value: {
      script,
      scriptLanguage: WORLD_ANIMATION_SCRIPT_LANGUAGE,
      scriptVersion: WORLD_ANIMATION_SCRIPT_VERSION,
      revision: revision as number,
      sourceHash,
      duration,
      loop
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type RawTrack = {
  targetId: string;
  property: string;
  startTime: number;
  endTime: number;
  from: number[];
  to: number[];
  easing: string;
};

class WorldAnimationRecorder {
  private readonly instanceTracks: RawTrack[] = [];
  private readonly cameraTracks: RawTrack[] = [];

  readonly instance = {
    tween: (targetId: unknown, options: unknown): void => {
      this.instanceTracks.push(rawTrack(targetId, options));
    }
  };

  readonly camera = {
    tween: (options: unknown): void => {
      const value = (options ?? {}) as Record<string, unknown>;
      this.cameraTracks.push(rawTrack(value.targetId ?? value.cameraId, options));
    }
  };

  raw(): { instanceTracks: RawTrack[]; cameraTracks: RawTrack[] } {
    return { instanceTracks: [...this.instanceTracks], cameraTracks: [...this.cameraTracks] };
  }
}

function rawTrack(targetId: unknown, options: unknown): RawTrack {
  const value = (options ?? {}) as Record<string, unknown>;
  return {
    targetId: typeof targetId === "string" ? targetId : "",
    property: typeof value.property === "string" ? value.property : "",
    startTime: typeof value.startTime === "number" ? value.startTime : Number.NaN,
    endTime: typeof value.endTime === "number" ? value.endTime : Number.NaN,
    from: Array.isArray(value.from) ? value.from.filter((entry): entry is number => typeof entry === "number") : [],
    to: Array.isArray(value.to) ? value.to.filter((entry): entry is number => typeof entry === "number") : [],
    easing: typeof value.easing === "string" ? value.easing : "linear"
  };
}

/** 执行一次动画脚本并做确定性重跑；失败隔离为结构化诊断。 */
export function executeWorldAnimationScript(
  source: string,
  input: { duration: number; loop: boolean }
): WorldAnimationScriptResult {
  const first = runWorldAnimationOnce(source, input);
  if (!first.ok) return first;
  const second = runWorldAnimationOnce(source, input);
  if (!second.ok) return second;
  if (first.json !== second.json) {
    return { ok: false, stage: "determinism", code: "non-deterministic", message: "同一动画脚本两次执行产生不同结果" };
  }
  return first;
}

function runWorldAnimationOnce(
  source: string,
  input: { duration: number; loop: boolean }
): WorldAnimationScriptResult {
  if (!(input.duration > 0) || input.duration > WORLD_ANIMATION_MAX_DURATION_SECONDS) {
    return { ok: false, stage: "invalid", code: "invalid-duration", message: "动画时长必须为 (0, 3600] 秒" };
  }
  let compiled: (motion: Record<string, unknown>) => unknown;
  try {
    const body = `${source}\n;if (typeof build === "function") build(motion);`;
    compiled = new Function("motion", body) as typeof compiled;
  } catch (error) {
    return { ok: false, stage: "compile", code: "syntax-error", message: error instanceof Error ? error.message : String(error) };
  }
  const recorder = new WorldAnimationRecorder();
  try {
    compiled(recorder as unknown as Record<string, unknown>);
  } catch (error) {
    return { ok: false, stage: "execute", code: "runtime-error", message: error instanceof Error ? error.message : String(error) };
  }
  const raw = recorder.raw();
  const instanceTracks: WorldInstanceTrack[] = [];
  const cameraTracks: WorldCameraTrack[] = [];
  for (const track of raw.instanceTracks) {
    const valid = validateTrack(track, input.duration, ["position", "rotation", "scale"]);
    if (!valid.ok) return valid;
    instanceTracks.push(valid.value as WorldInstanceTrack);
  }
  for (const track of raw.cameraTracks) {
    const valid = validateTrack(track, input.duration, ["position", "rotation", "zoom"]);
    if (!valid.ok) return valid;
    cameraTracks.push(valid.value as WorldCameraTrack);
  }
  if (instanceTracks.length + cameraTracks.length > WORLD_ANIMATION_MAX_TRACKS) {
    return { ok: false, stage: "invalid", code: "too-many-tracks", message: `轨道数量超过 ${WORLD_ANIMATION_MAX_TRACKS} 上限` };
  }
  const ir: WorldAnimationIr = {
    version: WORLD_ANIMATION_IR_VERSION,
    duration: input.duration,
    loop: input.loop,
    instanceTracks,
    cameraTracks
  };
  return { ok: true, ir, json: JSON.stringify(ir) };
}

function validateTrack(
  track: RawTrack,
  duration: number,
  properties: readonly string[]
): { ok: true; value: WorldInstanceTrack | WorldCameraTrack } | WorldAnimationScriptFailure {
  const scalar = track.property === "scale" || track.property === "zoom";
  const arity = scalar ? 1 : 3;
  const finite = [...track.from, ...track.to].every(value => Number.isFinite(value));
  if (
    track.targetId.trim() === ""
    || !properties.includes(track.property)
    || !finite
    || track.from.length !== arity
    || track.to.length !== arity
    || !Number.isFinite(track.startTime)
    || !Number.isFinite(track.endTime)
    || track.startTime < 0
    || track.endTime <= track.startTime
    || track.endTime > duration
    || !WORLD_ANIMATION_EASINGS.includes(track.easing as WorldAnimationEasing)
  ) {
    return { ok: false, stage: "invalid", code: "invalid-track", message: `动画轨道无效：${track.property || "unknown"} ${track.targetId || "unknown"}` };
  }
  return {
    ok: true,
    value: {
      targetId: track.targetId,
      property: track.property as WorldInstanceTrack["property"],
      startTime: track.startTime,
      endTime: track.endTime,
      from: [...track.from],
      to: [...track.to],
      easing: track.easing as WorldAnimationEasing
    }
  };
}

export type SampledInstanceMotion = {
  position?: WorldPoint;
  rotation?: WorldRotation;
  scale?: number;
};

export type SampledCameraMotion = {
  position?: WorldPoint;
  rotation?: WorldRotation;
  /** 镜头放大倍率：>1 更广（透视 fov / 等距尺寸一起放大）。 */
  zoom?: number;
};

/**
 * 在 time 秒采样动画 IR；未命中的部件不产生覆盖。
 * Position 值是脚本里的相对 u/v 偏移（h 为绝对高度），需要世界位置时用
 * `sampleWorldAnimationInArea` 加上导演区 origin。
 */
export function sampleWorldAnimation(
  ir: WorldAnimationIr,
  time: number
): { instances: Map<string, SampledInstanceMotion>; cameras: Map<string, SampledCameraMotion> } {
  const now = Number.isFinite(time) ? Math.max(0, Math.min(time, ir.duration)) : 0;
  const instances = new Map<string, SampledInstanceMotion>();
  const cameras = new Map<string, SampledCameraMotion>();
  for (const track of ir.instanceTracks) {
    const value = sampleTrack(track, now);
    if (!value) continue;
    const current = instances.get(track.targetId) ?? {};
    if (track.property === "position") current.position = { u: value[0]!, v: value[1]!, h: value[2]! };
    else if (track.property === "rotation") current.rotation = quatFromEulerYXZDegrees([value[0]!, value[1]!, value[2]!]);
    else current.scale = value[0]!;
    instances.set(track.targetId, current);
  }
  for (const track of ir.cameraTracks) {
    const value = sampleTrack(track, now);
    if (!value) continue;
    const current = cameras.get(track.targetId) ?? {};
    if (track.property === "position") current.position = { u: value[0]!, v: value[1]!, h: value[2]! };
    else if (track.property === "rotation") current.rotation = quatFromEulerYXZDegrees([value[0]!, value[1]!, value[2]!]);
    else current.zoom = value[0]!;
    cameras.set(track.targetId, current);
  }
  return { instances, cameras };
}

/**
 * 采样并把位置轨道换算到导演区 origin 所在的世界坐标。
 * 实例与镜头的 u/v 加 origin；h 保持脚本值。
 */
export function sampleWorldAnimationInArea(
  ir: WorldAnimationIr,
  time: number,
  origin: GroundPoint
): { instances: Map<string, SampledInstanceMotion>; cameras: Map<string, SampledCameraMotion> } {
  const sample = sampleWorldAnimation(ir, time);
  const shift = <T extends { position?: WorldPoint }>(motions: Map<string, T>) => {
    for (const motion of motions.values()) {
      if (motion.position) motion.position = {
        u: motion.position.u + origin.u,
        v: motion.position.v + origin.v,
        h: motion.position.h
      };
    }
  };
  shift(sample.instances);
  shift(sample.cameras);
  return sample;
}

function sampleTrack(track: WorldInstanceTrack | WorldCameraTrack, now: number): number[] | null {
  if (now <= track.startTime) return [...track.from];
  if (now >= track.endTime) return [...track.to];
  const progress = Math.max(0, Math.min(1, (now - track.startTime) / (track.endTime - track.startTime)));
  const t = easingProgress(track.easing, progress);
  return track.from.map((from, index) => from + ((track.to[index] ?? from) - from) * t);
}

/** 从 IR 反序列化为等价脚本（用于复制/迁移时重写目标身份）。 */
export function serializeWorldAnimationScript(ir: WorldAnimationIr): string {
  const lines: string[] = [];
  for (const track of ir.instanceTracks) {
    lines.push(`motion.instance.tween(${JSON.stringify(track.targetId)}, ${JSON.stringify({
      property: track.property, startTime: track.startTime, endTime: track.endTime,
      from: track.from, to: track.to, easing: track.easing
    })});`);
  }
  for (const track of ir.cameraTracks) {
    lines.push(`motion.camera.tween(${JSON.stringify({
      cameraId: track.targetId, property: track.property, startTime: track.startTime, endTime: track.endTime,
      from: track.from, to: track.to, easing: track.easing
    })});`);
  }
  return lines.join("\n");
}
