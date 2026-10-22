/**
 * 版本化 JavaScript `modelScript` 的执行骨架
 * （change: replace-godot-canvas-runtime-with-bevy，任务 4.1–4.4 / design D8；
 *  change: 2026-10-07-remove-residual-compatibility —— V2-only，删除 V1 recorder/executor）。
 *
 * 浏览器与 Canvas Service 共用同一实现：
 * - `runVersionedModelScript` 是编译 → 执行 → 校验 → 确定性重跑的版本无关骨架；
 * - V2 recorder 在 `model-executor-v2`；校验由 `scene-ir-v2` 承担；
 * - 单节点失败被隔离为结构化诊断，不抛出到调用方。
 *
 * 首版沿用现有信任模型（spec「首版沿用现有 JavaScript 信任模型」）：脚本直接执行，
 * 不以沙箱作为发布前置。Scene IR 只作为发送给 Bevy 的运行时 DTO。
 */
import type { ModelSceneIrV2 } from "./scene-ir-v2.js";

/** recorder 记录的一个原始 op（未校验）。 */
export type RawSceneOp = {
  t: string;
  id: string;
  [key: string]: unknown;
};

/**
 * SceneBuilder recorder 的共享形状说明：脚本通过注入的 `scene` 对象声明模型结构。
 *
 * 具体 recorder 在 `model-executor-v2`（`SceneBuilderV2`）。id 缺失时按 `<prefix>_<seq>`
 * 生成稳定序列；显式 id 优先。所有数值字段原样记录，校验交给对应 validator（不在这里静默纠正）。
 * 记录作者**显式声明**的部件 ID，运动目标校验只接受该集合。
 */

export type ModelScriptFailure = {
  ok: false;
  stage: "compile" | "execute" | "validate" | "determinism";
  code: string;
  message: string;
};

export type ModelScriptSuccess = {
  ok: true;
  scene: ModelSceneIrV2;
  /** 规范化后的 JSON 字符串（发给 Bevy）。 */
  json: string;
  /** 作者**显式声明**的部件 ID 集合。 */
  declaredIds: ReadonlySet<string>;
};

export type ModelScriptResult = ModelScriptSuccess | ModelScriptFailure;

/** 版本化 builder 的最小接口：能产出校验前的原始 op 列表与显式声明 ID。 */
export type VersionedSceneBuilder = { raw(): RawSceneOp[]; declaredIds?(): ReadonlySet<string> };

/** 校验原始 ops → 规范化 Scene IR；失败时返回稳定 code/message。 */
export type VersionedValidator<S> = (
  ops: RawSceneOp[]
) => { ok: true; scene: S; json: string } | { ok: false; code: string; message: string };

/**
 * 版本无关的执行骨架：编译 → 执行 → 校验 → 确定性重跑。
 *
 * V1 与 V2 executor 共用；注入 builder 工厂与 validator（校验器拥有版本与规范化规则）。
 */
export function runVersionedModelScript<S>(
  source: string,
  makeBuilder: () => VersionedSceneBuilder,
  validate: VersionedValidator<S>
): { ok: true; scene: S; json: string; declaredIds: ReadonlySet<string> } | ModelScriptFailure {
  const first = runOnceWith(source, makeBuilder, validate);
  if (!first.ok) return first;

  // 确定性：再次执行必须得到逐字节相同的 Scene IR。
  const second = runOnceWith(source, makeBuilder, validate);
  if (!second.ok) return second;
  if (first.json !== second.json) {
    return {
      ok: false,
      stage: "determinism",
      code: "non-deterministic",
      message: "同一脚本两次执行产生不同的 Scene IR"
    };
  }
  return first;
}

function runOnceWith<S>(
  source: string,
  makeBuilder: () => VersionedSceneBuilder,
  validate: VersionedValidator<S>
): { ok: true; scene: S; json: string; declaredIds: ReadonlySet<string> } | ModelScriptFailure {
  let compiled: (scene: Record<string, unknown>, rangeNum: (a: number, b?: number, c?: number) => number[]) => unknown;
  try {
    // 与 design D8 一致：等价于 new Function("scene", source)；额外注入 rangeNum。
    // 若脚本（含 GDScript 转译产物）声明了顶层 `build`，执行器调用它，与 GDScript 入口语义一致；
    // 原生顶层脚本（直接调用 scene.*）不受影响。
    const body = `${source}\n;if (typeof build === "function") build(scene);`;
    compiled = new Function("scene", "rangeNum", body) as typeof compiled;
  } catch (error) {
    return {
      ok: false,
      stage: "compile",
      code: "syntax-error",
      message: error instanceof Error ? error.message : String(error)
    };
  }

  const builder = makeBuilder();
  try {
    compiled(builder as Record<string, unknown>, rangeNum);
  } catch (error) {
    return {
      ok: false,
      stage: "execute",
      code: "runtime-error",
      message: error instanceof Error ? error.message : String(error)
    };
  }

  const validation = validate(builder.raw());
  if (!validation.ok) {
    return {
      ok: false,
      stage: "validate",
      code: validation.code satisfies string,
      message: validation.message
    };
  }
  return {
    ok: true,
    scene: validation.scene,
    json: validation.json,
    declaredIds: builder.declaredIds?.() ?? new Set<string>()
  };
}

/** 内容哈希：迁移 provenance / 并发 precondition / 稳定 commandId 共用。 */
export function hashModelScript(source: string): string {
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** `range` 的 JavaScript 等价物，注入给脚本与 GDScript 转译产物。
 * `range(n)` → 0..n-1；`range(a,b)` → a..b-1；`range(a,b,c)` → 步进。
 */
export function rangeNum(a: number, b?: number, c?: number): number[] {  const start = b === undefined ? 0 : a;
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
