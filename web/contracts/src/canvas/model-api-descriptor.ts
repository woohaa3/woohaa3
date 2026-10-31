/**
 * 版本化模型 API descriptor（change: enhance-model-scene-authoring-api，任务 5.1 / design D8；
 *  change: 2026-10-07-remove-residual-compatibility —— 收敛到 V2）。
 *
 * 单一事实来源：MCP `get_model_api` 指南的方法集合、默认版本与单位说明都由这里生成，
 * 避免文档与 executor 漂移。contract test 会让指南代码块真的过 V2 executor。
 */
import {
  MODEL_SCRIPT_LANGUAGE,
  MODEL_SCRIPT_V2_VERSION,
  PREFERRED_MODEL_SCRIPT_VERSION,
  SUPPORTED_MODEL_SCRIPT_VERSIONS,
  type SupportedModelScriptVersion
} from "./model-script.js";
import { QUALITY_VERTEX_COUNTS } from "./scene-ir-v2/types.js";

/**
 * 坐标 / 旋转单位、朝向与**长度基准**约定。
 *
 * `lengthUnit` / `unitMeters` 让模型脚本的绝对尺寸有统一口径：模型卡片按自身 extent 归一化显示，
 * 只看卡片无法发现「人物 1.7、椅子 100」，因此必须把现实尺度写进指南与生成提示词，而不是留空。
 */
export const MODEL_API_AXIS_CONVENTIONS = {
  up: "+Y",
  front: "+Z",
  left: "+X",
  rotationUnit: "degrees",
  rotationOrder: "local Y-X-Z (intrinsic)",
  positionSpace: "parent local space",
  timeUnit: "seconds",
  lengthUnit: "meters",
  unitMeters: 1,
  /** 站立人物的基准身高（场景单位）；允许风格化夸张，但不应偏离数量级。 */
  standingPersonHeightUnits: 1.7,
  doorHeightUnits: 2,
  chairSeatHeightUnits: 0.45
} as const;

/**
 * 供生成提示词使用的**现实尺度基准**说明（English，稳定输出）。
 *
 * 与 `modelRenderBudgetText()` / `modelPrimitiveConstraintsText()` 同一定位：生成提示词与 MCP 指南
 * 共享同一份常量，避免 agent 按任意单位建模型后在片场里大小错配。
 */
export function modelScaleGuidanceText(): string {
  const { unitMeters, standingPersonHeightUnits, doorHeightUnits, chairSeatHeightUnits } = MODEL_API_AXIS_CONVENTIONS;
  return [
    `Scene scale is life-like: 1 unit ≈ ${unitMeters} meter.`,
    `Build every object at its real-world size (a standing person ≈ ${standingPersonHeightUnits} units tall, a door ≈ ${doorHeightUnits} units, a chair seat ≈ ${chairSeatHeightUnits} units).`,
    "For objects that stand on the ground, place the model origin at its ground contact and center it horizontally; do not arbitrarily enlarge the whole model."
  ].join(" ");
}

/** 同一尺度基准的中文版（MCP 指南与中文提示词共用）。 */
export function modelScaleGuidanceTextZh(): string {
  const { unitMeters, standingPersonHeightUnits, doorHeightUnits, chairSeatHeightUnits } = MODEL_API_AXIS_CONVENTIONS;
  return [
    `1 单位 ≈ ${unitMeters} 米，按真实尺寸建模`,
    `（站立人物约 ${standingPersonHeightUnits} 单位高，门约 ${doorHeightUnits} 单位，椅子座高约 ${chairSeatHeightUnits} 单位）；`,
    "站在地面上的对象，让模型原点落在其地面接触点并水平居中；不要把整体模型任意放大。"
  ].join("");
}

/** 一个 SceneBuilder 方法签名（供指南与一致性测试共用）。 */
export type ModelApiMethod = {
  name: string;
  signature: string;
  /** 该方法在哪些版本可用。 */
  versions: readonly SupportedModelScriptVersion[];
};

const V2 = MODEL_SCRIPT_V2_VERSION;

/** V2 场景方法集合。 */
export const MODEL_API_METHODS: readonly ModelApiMethod[] = [
  { name: "material", signature: "scene.material({ id?, baseColor?, roughness?, metallic?, emissive?, emissiveStrength?, alphaMode?: 'opaque'|'blend', doubleSided?, unlit?: boolean, opacity?: 0..1 }) => materialId", versions: [V2] },
  { name: "group", signature: "scene.group({ id?, parent?, position?, rotation?, scale? }) => id", versions: [V2] },
  { name: "box", signature: "scene.box({ id?, parent?, size: [x,y,z], position?, rotation?, scale?, color? | material? }) => id", versions: [V2] },
  { name: "cylinder", signature: "scene.cylinder({ id?, parent?, radius, height, position?, rotation?, scale?, color? | material? }) => id", versions: [V2] },
  { name: "sphere", signature: "scene.sphere({ id?, parent?, radius, position?, rotation?, scale?, color? | material? }) => id", versions: [V2] },
  { name: "capsule", signature: "scene.capsule({ id?, parent?, radius, height, position?, rotation?, scale?, color? | material? }) => id（height 含两端半球）", versions: [V2] },
  { name: "segment", signature: "scene.segment({ id?, parent?, from, to, width, depth?, shape?: 'box'|'capsule'（缺省 capsule）, overlap?, color? | material? }) => id", versions: [V2] },
  { name: "mesh", signature: "scene.mesh({ id?, parent?, vertices: [[x,y,z],...], faces: [[i,j,k],...], position?, rotation?, scale?, color? | material? }) => id", versions: [V2] },
  { name: "oscillate", signature: "scene.oscillate(id, { axis, mode?, amplitude?, speed?, phase? }) => id", versions: [V2] },
  { name: "move", signature: "scene.move(id, { axis, range: [min,max], speed? }) => id", versions: [V2] },
  { name: "rotate", signature: "scene.rotate(id, { axis, speed? }) => id", versions: [V2] }
];

/** 某个版本可用的方法名集合（一致性测试据此比对指南文本）。 */
export function modelApiMethodNames(version: SupportedModelScriptVersion): string[] {
  return MODEL_API_METHODS.filter((method) => method.versions.includes(version)).map((method) => method.name);
}

/**
 * 单个 primitive 的估算 tessellation 顶点成本。
 *
 * change: 2026-10-22-remove-agent-execution-limits，任务 6.2 / design D6：这里原本用于表达
 * 「单场景估算顶点上限」并在校验侧整份拒绝超预算候选。该应用侧总量门禁已删除；保留的成本表
 * 只作为**创作质量指引**（用少量、尺寸合理的可编辑图元，而不是海量小图元堆砌），
 * 由渲染端按真实后端能力渐进准备，不作为拒绝合法作品的依据。
 */
export const MODEL_RENDER_BUDGET = {
  /** 单个 primitive 的估算顶点成本（segment 按自身 shape 取 box/capsule）。 */
  vertexCost: {
    box: QUALITY_VERTEX_COUNTS.box,
    cylinder: QUALITY_VERTEX_COUNTS.cylinder,
    sphere: QUALITY_VERTEX_COUNTS.sphere,
    capsule: QUALITY_VERTEX_COUNTS.capsule
  }
} as const;

/**
 * 供生成提示词使用的英文创作质量说明（不是拒绝阈值）。
 *
 * 数字全部由常量派生、输出稳定（无随机/时间），可直接放进提示词并被断言。
 */
export function modelRenderBudgetText(): string {
  const { vertexCost } = MODEL_RENDER_BUDGET;
  return [
    "Editability guidance: prefer a small number of well-proportioned, editable primitives over piling up thousands of tiny primitives.",
    `Per-primitive tessellation cost: box=${vertexCost.box}, segment(box)=${vertexCost.box}, cylinder=${vertexCost.cylinder}, sphere=${vertexCost.sphere}, capsule=${vertexCost.capsule}, segment(capsule)=${vertexCost.capsule}, mesh=its declared vertex count.`,
    "A segment WITHOUT shape is a capsule, not a box: it costs the capsule count above. Pass shape:'box' explicitly for boxy limbs.",
    "This is a quality guideline, not a hard limit: large scenes are prepared progressively by the renderer. Thousands of tiny primitives still make the result hard to edit, so use few, larger, well-proportioned parts and share materials."
  ].join(" ");
}

/**
 * 供生成提示词使用的**图元合法性约束**说明（English，稳定输出）。
 *
 * 这些是 Scene IR 读取/校验的隐式几何约束：不写进提示词时，模型会产出结构合法但违反约束的候选
 * 而被整份拒绝（例如 `capsule` 总高度小于直径）。与 `modelRenderBudgetText()` 一样，是提示词与
 * 执行器/校验之间的单一事实来源；服务端另有回喂修复作为兜底。
 */
export function modelPrimitiveConstraintsText(): string {
  return [
    "Primitive constraints (violating ANY of them fails validation):",
    "every box size, cylinder/sphere/capsule radius and cylinder/capsule height MUST be > 0;",
    "a capsule's total height (including both hemispheres) MUST be >= 2*radius;",
    "a segment's from and to MUST differ (no zero-length segment);",
    "a mesh MUST declare at least one vertex and one face;",
    "a shape MUST NOT set both material and color;",
    "material.opacity (0..1) is only valid with alphaMode 'blend'; it defaults to 0.6;",
    "material.unlit renders a flat unlit color;",
    "object ids MUST be unique, and a parent MUST be created before its children."
  ].join(" ");
}

/**
 * 指南里的最短连续人物示例：上臂 box、前臂 box、共享肘坐标 + 关节 sphere、金属材质。
 *
 * contract test 会把它交给 V2 executor 执行并校验 Scene IR。
 */
export const HUMAN_FIXTURE_SCRIPT = `const armor = scene.material({ id: "armor", baseColor: "#26343a", metallic: 0.85, roughness: 0.35 });
scene.box({ id: "torso", size: [0.9, 1.5, 0.5], position: [0, 1.8, 0], color: "#cc8844" });
const shoulder = [-0.6, 2.25, 0];
const elbow = [-1.0, 1.6, 0];
const wrist = [-1.0, 0.95, 0];
scene.sphere({ id: "shoulder-joint", radius: 0.22, position: shoulder, material: armor });
scene.segment({ id: "upper-arm", from: shoulder, to: elbow, width: 0.26, shape: "box", material: armor });
scene.segment({ id: "forearm", from: elbow, to: wrist, width: 0.24, shape: "box", material: armor });
scene.sphere({ id: "hand", radius: 0.16, position: wrist, color: "#e8c39e" });`;

export type ModelApiGuide = {
  language: typeof MODEL_SCRIPT_LANGUAGE;
  preferredVersion: SupportedModelScriptVersion;
  supportedVersions: readonly SupportedModelScriptVersion[];
  conventions: typeof MODEL_API_AXIS_CONVENTIONS;
  methods: readonly ModelApiMethod[];
  example: string;
};

/** 结构化 API 指南（由 MCP 渲染为文本，测试据此比对方法集合）。 */
export function modelApiGuide(): ModelApiGuide {
  return {
    language: MODEL_SCRIPT_LANGUAGE,
    preferredVersion: PREFERRED_MODEL_SCRIPT_VERSION,
    supportedVersions: SUPPORTED_MODEL_SCRIPT_VERSIONS,
    conventions: MODEL_API_AXIS_CONVENTIONS,
    methods: MODEL_API_METHODS,
    example: HUMAN_FIXTURE_SCRIPT
  };
}
