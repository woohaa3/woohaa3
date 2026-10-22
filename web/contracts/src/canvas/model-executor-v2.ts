/**
 * `woohaa-model-js-v2` SceneBuilder recorder 与版本化 executor dispatch
 * （change: enhance-model-scene-authoring-api，任务 1.1 / 1.3 / 2.4）。
 *
 * V2 在 V1 之上增加：
 * - `material`：声明稳定 ID 的受控 PBR 材质，返回 material ID 供 shape 引用；
 * - `sphere` / `capsule`：原生连续 primitive；
 * - `segment`：端点式部件，保存 from/to/width/depth/shape/overlap 作者意图，
 *   不在 recorder 中展开（design D4）。
 *
 * 与 V1 一致：id 缺失时按 `<prefix>_<seq>` 生成稳定序列；数值原样记录，校验交给
 * `validateModelSceneIrV2`；同一脚本执行两次必须得到逐字节相同的规范化 Scene IR。
 * V1 与 V2 共用 `runVersionedModelScript` 的四阶段骨架（编译/执行/校验/确定性重跑）。
 */
import {
  MODEL_SCRIPT_SCENE_IR_V2_VERSION,
  MODEL_SCRIPT_V2_VERSION,
  isSupportedModelScriptVersion
} from "./model-script.js";
import {
  runVersionedModelScript,
  type ModelScriptFailure,
  type RawSceneOp
} from "./model-executor.js";
import { validateModelSceneIrV2, type ModelSceneIrV2, type SceneV2Op } from "./scene-ir-v2.js";

/** V2 recorder 记录的一个原始 op（未校验）。 */
export type RawSceneV2Op = RawSceneOp;

/** V2 SceneBuilder 版本常量。 */
export const SCENE_BUILDER_V2_VERSION = MODEL_SCRIPT_V2_VERSION;

/** V2 执行结果：成功时 `scene` 为规范化 V2 IR。 */
export type ModelScriptV2Result =
  | { ok: true; scene: ModelSceneIrV2; json: string; declaredIds: ReadonlySet<string> }
  | ModelScriptFailure;

/** executor 结果（V2-only）。 */
export type VersionedModelScriptResult = ModelScriptV2Result;

/**
 * V2 SceneBuilder recorder。
 *
 * `material()` 返回声明的 ID（脚本据此引用）；其余方法返回对象 ID。`segment()` 保留
 * 端点与作者意图，由运行时确定性求中心/朝向。
 */
export class SceneBuilderV2 {
  private readonly ops: RawSceneOp[] = [];
  private readonly explicitIds = new Set<string>();
  private sequence = 0;

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${this.sequence}`;
  }

  private shape(t: string, options: Record<string, unknown> = {}): string {
    const explicit = asExplicitId(options.id);
    const id = explicit ?? this.nextId(t);
    if (explicit) this.explicitIds.add(id);
    const { id: _ignored, ...rest } = options;
    this.ops.push({ ...rest, t, id } as RawSceneOp);
    return id;
  }

  material(options: Record<string, unknown> = {}): string {
    const explicit = asExplicitId(options.id);
    const id = explicit ?? this.nextId("material");
    if (explicit) this.explicitIds.add(id);
    const { id: _ignored, ...rest } = options;
    this.ops.push({ ...rest, t: "material", id });
    return id;
  }

  group(options: Record<string, unknown> = {}): string {
    return this.shape("group", options);
  }

  box(options: Record<string, unknown> = {}): string {
    return this.shape("box", options);
  }

  cylinder(options: Record<string, unknown> = {}): string {
    return this.shape("cylinder", options);
  }

  sphere(options: Record<string, unknown> = {}): string {
    return this.shape("sphere", options);
  }

  capsule(options: Record<string, unknown> = {}): string {
    return this.shape("capsule", options);
  }

  segment(options: Record<string, unknown> = {}): string {
    return this.shape("segment", options);
  }

  mesh(options: Record<string, unknown> = {}): string {
    return this.shape("mesh", options);
  }

  oscillate(id: string, options: Record<string, unknown> = {}): string {
    return this.animation("oscillate", id, options);
  }

  move(id: string, options: Record<string, unknown> = {}): string {
    return this.animation("move", id, options);
  }

  rotate(id: string, options: Record<string, unknown> = {}): string {
    return this.animation("rotate", id, options);
  }

  private animation(t: string, id: string, options: Record<string, unknown>): string {
    const { id: _ignored, ...rest } = options;
    this.ops.push({ ...rest, t, id });
    return id;
  }

  /** 原始 op 列表（校验前）。 */
  raw(): RawSceneOp[] {
    return [...this.ops];
  }

  /** 作者显式声明的部件 ID 集合（change: 2026-10-06，任务 1.5）。 */
  declaredIds(): ReadonlySet<string> {
    return this.explicitIds;
  }
}

/** 执行一份 `woohaa-model-js-v2` 脚本，返回校验通过的规范化 V2 Scene IR。 */
export function executeModelScriptV2(source: string): ModelScriptV2Result {
  return runVersionedModelScript(source, () => new SceneBuilderV2(), (ops) => {
    const validation = validateModelSceneIrV2({ version: MODEL_SCRIPT_SCENE_IR_V2_VERSION, ops });
    if (!validation.ok) {
      return { ok: false, code: validation.code, message: validation.message };
    }
    return { ok: true, scene: validation.scene, json: JSON.stringify(validation.scene) };
  });
}

/**
 * 按脚本版本执行（V2-only）。
 *
 * 未知/不支持版本返回稳定的 `version-mismatch` 失败（change:
 * 2026-10-07-remove-residual-compatibility —— 不再支持 V1）。
 */
export function executeModelScriptVersioned(
  source: string,
  version: unknown
): VersionedModelScriptResult {
  if (!isSupportedModelScriptVersion(version)) {
    return {
      ok: false,
      stage: "compile",
      code: "version-mismatch",
      message: `不支持的 modelScriptVersion ${String(version)}`
    };
  }
  return executeModelScriptV2(source);
}

/** 脚本版本 → 该版本 Scene IR op 类型（判别用）。 */
export type VersionedSceneV2Ops = SceneV2Op[];

function asExplicitId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
