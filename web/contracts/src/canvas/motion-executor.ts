/**
 * `woohaa-motion-js-v1` 运动脚本 recorder 与确定性执行器
 * （change: 2026-10-05-bind-model-animation-to-shots，任务 1.4）。
 *
 * 与模型 executor 同构：编译 → 执行 → 校验 → 确定性重跑。脚本通过注入的 `motion` 对象声明
 * 镜头轨道与模型轨道，执行结果为受控 `MotionIr`（见 `motion-ir`）。单节点失败被隔离为结构化
 * 诊断，不抛出到调用方。
 *
 * 运动脚本不创建几何、不读取其他节点，只通过稳定部件 ID（string）引用本节点模型；
 * recorder 不解析这些 ID，合法性由 `validateMotionIr` 对着模型部件集合校验。
 */
import {
  MOTION_IR_VERSION,
  validateMotionIr,
  type Axis3,
  type CameraTrack,
  type CameraTrackProperty,
  type ModelMotion,
  type ModelTrack,
  type MotionEasing,
  type MotionIr,
  type OscillateMode
} from "./motion-ir.js";

/** motion recorder 版本；与 `motionScriptVersion` 对应。 */
export const MOTION_RECORDER_VERSION = "woohaa-motion-js-v1" as const;

/** recorder 记录的一条原始轨道（未校验）。 */
export type RawMotionTrack = Record<string, unknown>;

/**
 * 运动 recorder：脚本通过 `motion.camera.*` 与 `motion.model.*` 声明轨道。
 *
 * id 缺失时按 `<prefix>_<seq>` 生成稳定序列；数值原样记录，校验交给 `validateMotionIr`。
 */
export class MotionRecorder {
  private readonly cameraMotion: RawMotionTrack[] = [];
  private readonly modelMotion: RawMotionTrack[] = [];
  private sequence = 0;

  readonly camera = {
    tween: (options: Record<string, unknown> = {}): string => this.cameraTrack(options)
  };

  readonly model = {
    tween: (targetId: string, options: Record<string, unknown> = {}): string => this.modelTrack(targetId, "tween", options),
    keyframes: (targetId: string, options: Record<string, unknown> = {}): string => this.modelTrack(targetId, "keyframes", options),
    rotate: (targetId: string, options: Record<string, unknown> = {}): string =>
      this.modelTrack(targetId, "rotate", options),
    move: (targetId: string, options: Record<string, unknown> = {}): string =>
      this.modelTrack(targetId, "move", options),
    oscillate: (targetId: string, options: Record<string, unknown> = {}): string =>
      this.modelTrack(targetId, "oscillate", options)
  };

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${this.sequence}`;
  }

  private cameraTrack(options: Record<string, unknown>): string {
    const id = asId(options.id, () => this.nextId("camera"));
    const { id: _ignored, ...rest } = options;
    this.cameraMotion.push({ ...rest, id });
    return id;
  }

  private modelTrack(targetId: string, kind: string, options: Record<string, unknown>): string {
    const id = asId(options.id, () => this.nextId(kind));
    const { id: _ignored, startTime, endTime, ...motion } = options;
    this.modelMotion.push({
      id,
      targetId,
      ...(startTime === undefined ? {} : { startTime }),
      ...(endTime === undefined ? {} : { endTime }),
      motion: { ...motion, kind }
    });
    return id;
  }

  /** 原始轨道列表（校验前）。 */
  raw(): { cameraMotion: RawMotionTrack[]; modelMotion: RawMotionTrack[] } {
    return { cameraMotion: [...this.cameraMotion], modelMotion: [...this.modelMotion] };
  }
}

export type MotionScriptFailure = {
  ok: false;
  stage: "compile" | "execute" | "validate" | "determinism";
  code: string;
  message: string;
};

export type MotionScriptSuccess = {
  ok: true;
  ir: MotionIr;
  /** 规范化后的 JSON 字符串（发给执行器）。 */
  json: string;
};

export type MotionScriptResult = MotionScriptSuccess | MotionScriptFailure;

export type MotionScriptContext = {
  /** 时间线时长（秒）。 */
  duration: number;
  /** 本节点模型的稳定部件 ID 集合；给定后模型轨道目标必须存在。 */
  partIds?: ReadonlySet<string>;
};

/**
 * 执行一份 `woohaa-motion-js-v1` 运动脚本，返回校验通过的规范化 `MotionIr`。
 *
 * 阶段与模型脚本一致：编译 → 执行 → 校验 → 确定性重跑（两次执行逐字节相同）。
 */
export function executeMotionScript(source: string, context: MotionScriptContext): MotionScriptResult {
  const first = runMotionOnce(source, context);
  if (!first.ok) return first;
  const second = runMotionOnce(source, context);
  if (!second.ok) return second;
  if (first.json !== second.json) {
    return {
      ok: false,
      stage: "determinism",
      code: "non-deterministic",
      message: "同一运动脚本两次执行产生不同的 Motion IR"
    };
  }
  return first;
}

function runMotionOnce(source: string, context: MotionScriptContext): MotionScriptResult {
  let compiled: (motion: Record<string, unknown>, rangeNum: (a: number, b?: number, c?: number) => number[]) => unknown;
  try {
    const body = `${source}\n;if (typeof build === "function") build(motion);`;
    compiled = new Function("motion", "rangeNum", body) as typeof compiled;
  } catch (error) {
    return {
      ok: false,
      stage: "compile",
      code: "syntax-error",
      message: error instanceof Error ? error.message : String(error)
    };
  }

  const recorder = new MotionRecorder();
  try {
    compiled(recorder as unknown as Record<string, unknown>, rangeNum);
  } catch (error) {
    return {
      ok: false,
      stage: "execute",
      code: "runtime-error",
      message: error instanceof Error ? error.message : String(error)
    };
  }

  const raw = recorder.raw();
  const validation = validateMotionIr(
    { version: MOTION_IR_VERSION, cameraMotion: raw.cameraMotion, modelMotion: raw.modelMotion },
    { duration: context.duration, ...(context.partIds ? { partIds: context.partIds } : {}) }
  );
  if (!validation.ok) {
    return { ok: false, stage: "validate", code: validation.code, message: validation.message };
  }
  return { ok: true, ir: validation.ir, json: JSON.stringify(validation.ir) };
}

/** `range` 的 JavaScript 等价物（与模型 executor 一致）。 */
function rangeNum(a: number, b?: number, c?: number): number[] {
  const start = b === undefined ? 0 : a;
  const end = b === undefined ? a : b;
  const step = c ?? 1;
  const result: number[] = [];
  if (step === 0) return result;
  if (step > 0) {
    for (let value = start; value < end; value += step) result.push(value);
  } else {
    for (let value = start; value > end; value += step) result.push(value);
  }
  return result;
}

export type {
  Axis3,
  CameraTrack,
  CameraTrackProperty,
  ModelMotion,
  ModelTrack,
  MotionEasing,
  MotionIr,
  OscillateMode
};

function asId(value: unknown, fallback: () => string): string {
  if (typeof value === "string" && value.length > 0) return value;
  return fallback();
}
