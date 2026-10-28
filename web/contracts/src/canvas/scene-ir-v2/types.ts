/**
 * Scene IR V2：DTO 类型、上限常量与错误码
 * （自 `scene-ir-v2.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R14）。
 *
 * 纯类型/常量叶子，无校验逻辑。V2 在 V1 之上增加真实层级、连续 primitive 与受控 PBR material。
 */
import { MODEL_SCRIPT_SCENE_IR_V2_VERSION } from "../model-script.js";
import type { Vec3 } from "../model-transform.js";

export const SCENE_IR_V2_VERSION = MODEL_SCRIPT_SCENE_IR_V2_VERSION;

/**
 * 真实表达/正确性边界（**不是**应用执行额度）。
 *
 * change: 2026-10-22-remove-agent-execution-limits，任务 6.2 / design D6：原 op 数（4096）、
 * material 数（256）、层级深度（16）、累计/估算顶点与面数（20 万/40 万）等应用侧总量门禁已删除。
 * 保留的是不能由应用任意记账绕过的真实边界：
 * - 单个 mesh 的顶点/面数由 16 位索引宽度决定（`SCENE_IR_V2_MAX_MESH_VERTICES`/`FACES`），
 *   超出时必须改用分段的合法表示，而不是把整份场景判为失败；
 * - 坐标绝对值、有限数值、引用存在性与无环层级是正确性约束。
 */
export const SCENE_IR_V2_MAX_MESH_VERTICES = 65_000;
export const SCENE_IR_V2_MAX_MESH_FACES = 130_000;
export const SCENE_IR_V2_COORD_LIMIT = 1_000_000;
/** segment 最小长度（低于此值视为退化）。 */
export const SCENE_IR_V2_MIN_SEGMENT_LENGTH = 1e-4;
/** capsule 总高度必须 ≥ 直径；留一点浮点余量。 */
export const CAPSULE_EPSILON = 1e-6;
/** PBR 数值上限：emissiveStrength 使用受控上限，避免过曝。 */
export const SCENE_IR_V2_MAX_EMISSIVE_STRENGTH = 32;

/** 运行时质量档：脚本不能声明细分，由这里固定，便于估算 GPU 成本。 */
export const PRIMITIVE_QUALITY = {
  /** UV 球经线分段。 */
  sphereSectors: 24,
  /** UV 球纬线分段（不含两极）。 */
  sphereRings: 12,
  /** 圆柱/胶囊侧面分段。 */
  capsuleSegments: 24,
  /** 半球纬线分段。 */
  hemisphereRings: 6
} as const;

export const QUALITY_VERTEX_COUNTS = {
  sphere: (PRIMITIVE_QUALITY.sphereRings + 1) * (PRIMITIVE_QUALITY.sphereSectors + 1) + 2,
  capsule: (PRIMITIVE_QUALITY.capsuleSegments + 1) * 2 + (PRIMITIVE_QUALITY.hemisphereRings + 1) * (PRIMITIVE_QUALITY.capsuleSegments + 1) * 2,
  cylinder: (PRIMITIVE_QUALITY.capsuleSegments + 1) * 2 + 2,
  box: 8
} as const;

export type SceneV2MaterialAlphaMode = "opaque" | "blend";

/** 受控 PBR material 声明（无 transform）。 */
export type SceneV2MaterialOp = {
  t: "material";
  id: string;
  baseColor: string;
  roughness: number;
  metallic: number;
  emissive: string;
  emissiveStrength: number;
  alphaMode: SceneV2MaterialAlphaMode;
  doubleSided: boolean;
  /**
   * 不受光照，呈平面色（change: 2026-10-19-extend-film-set-for-motion-graphics，D4）。
   *
   * 可选：缺失即受光照，保持旧场景内容身份与材质缓存键不变。
   */
  unlit?: boolean;
  /**
   * blend 模式下的静态透明度（0..1，缺省 0.6）；其它模式出现即拒绝。
   *
   * 可选：缺失时按 [`SCENE_V2_DEFAULT_BLEND_OPACITY`] 呈现，且不写入规范 op。
   */
  opacity?: number;
  /**
   * 内嵌纹理（GLB 文件模型）的稳定纹理 id
   * （change: 2026-10-28-support-glb-model-nodes）。
   *
   * 纹理本身不进入 Scene IR / 规范 nodeData：由前端从原始 GLB 解码后经独立纹理通道上传，
   * Rust 侧按 id 解析。缺失时保持纯色（旧场景内容身份逐字节不变）。
   */
  baseColorTexture?: string;
};

/** blend 模式下未声明 `opacity` 时的静态透明度（与改动前的固定值一致）。 */
export const SCENE_V2_DEFAULT_BLEND_OPACITY = 0.6;

export type SceneV2ShapeBase = {
  id: string;
  parent: string | null;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  /** 引用的 material ID；与 `color` 互斥。 */
  material: string | null;
  /** 简单材质简写（默认非金属高粗糙）；与 `material` 互斥。 */
  color: string | null;
};

export type SceneV2GroupOp = SceneV2ShapeBase & { t: "group" };
export type SceneV2BoxOp = SceneV2ShapeBase & { t: "box"; size: Vec3 };
export type SceneV2CylinderOp = SceneV2ShapeBase & { t: "cylinder"; radius: number; height: number };
export type SceneV2SphereOp = SceneV2ShapeBase & { t: "sphere"; radius: number };
export type SceneV2CapsuleOp = SceneV2ShapeBase & { t: "capsule"; radius: number; height: number };
export type SceneV2MeshOp = SceneV2ShapeBase & {
  t: "mesh";
  vertices: Vec3[];
  faces: number[][];
  /**
   * 可选顶点属性（GLB 文件模型；change: 2026-10-28-support-glb-model-nodes）。
   *
   * 长度必须与 `vertices` 一致；缺失时由运行时光滑法线回退（旧脚本场景语义不变）。
   */
  normals?: Vec3[];
  uvs?: [number, number][];
  colors?: [number, number, number, number][];
};
export type SceneV2SegmentOp = SceneV2ShapeBase & {
  t: "segment";
  from: Vec3;
  to: Vec3;
  width: number;
  depth: number;
  shape: "box" | "capsule";
  overlap: number;
};

/** 可承载材质的实体（group 无几何）。 */
export type SceneV2SolidOp =
  | SceneV2BoxOp
  | SceneV2CylinderOp
  | SceneV2SphereOp
  | SceneV2CapsuleOp
  | SceneV2MeshOp
  | SceneV2SegmentOp;

export type SceneV2ShapeOp = SceneV2GroupOp | SceneV2SolidOp;

export type SceneV2AnimationOp = {
  t: "oscillate" | "move" | "rotate";
  id: string;
  axis: "x" | "y" | "z";
  mode?: "position" | "rotation" | "scale";
  amplitude?: number;
  speed?: number;
  phase?: number;
  range?: [number, number];
};

export type SceneV2Op = SceneV2ShapeOp | SceneV2MaterialOp | SceneV2AnimationOp;

export type ModelSceneIrV2 = {
  version: typeof SCENE_IR_V2_VERSION;
  ops: SceneV2Op[];
};

export type SceneIrV2Validation =
  | { ok: true; scene: ModelSceneIrV2 }
  | { ok: false; code: SceneIrV2ErrorCode; message: string };

/** Scene IR 通用错误码（change: 2026-10-07-remove-residual-compatibility —— 由 V2 拥有）。 */
export type SceneIrErrorCode =
  | "not-object"
  | "version-mismatch"
  | "ops-not-array"
  | "too-many-ops"
  | "unknown-op"
  | "invalid-id"
  | "duplicate-id"
  | "invalid-parent"
  | "parent-cycle"
  | "animation-before-target"
  | "missing-target"
  | "invalid-number"
  | "invalid-vector"
  | "invalid-color"
  | "mesh-too-large"
  | "scene-too-large"
  | "invalid-mesh";

/** V2 在通用错误码之上新增语义化错误码。 */
export type SceneIrV2ErrorCode =
  | SceneIrErrorCode
  | "invalid-material"
  | "missing-material"
  | "duplicate-material"
  | "invalid-primitive"
  | "degenerate-segment"
  | "hierarchy-too-deep"
  | "render-budget-exceeded";

export type ReadResult<T> = { ok: true; value: T } | { ok: false; code: SceneIrV2ErrorCode; message: string };

export const V2_SHAPE_OPS = new Set(["group", "box", "cylinder", "mesh", "sphere", "capsule", "segment"]);
export const V2_ANIMATION_OPS = new Set(["oscillate", "move", "rotate"]);
export const AXES = new Set(["x", "y", "z"]);
export const MODES = new Set(["position", "rotation", "scale"]);
export const SEGMENT_SHAPES = new Set(["box", "capsule"]);
export const ALPHA_MODES = new Set(["opaque", "blend"]);
export const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

export function fail(code: SceneIrV2ErrorCode, message: string): { ok: false; code: SceneIrV2ErrorCode; message: string } {
  return { ok: false, code, message };
}

export function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/** 单个 primitive 的估算顶点数（与运行时质量档一致，validator 与 Rust 共用数量级）。 */
export function estimatePrimitiveVertices(op: SceneV2SolidOp): number {
  switch (op.t) {
    case "sphere":
      return QUALITY_VERTEX_COUNTS.sphere;
    case "capsule":
      return QUALITY_VERTEX_COUNTS.capsule;
    case "cylinder":
      return QUALITY_VERTEX_COUNTS.cylinder;
    case "segment":
      return op.shape === "capsule" ? QUALITY_VERTEX_COUNTS.capsule : QUALITY_VERTEX_COUNTS.box;
    case "box":
      return QUALITY_VERTEX_COUNTS.box;
    case "mesh":
      return op.vertices.length;
    default:
      return 0;
  }
}
