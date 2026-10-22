/**
 * Scene IR V2：DTO 类型、上限常量与错误码
 * （自 `scene-ir-v2.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R14）。
 *
 * 纯类型/常量叶子，无校验逻辑。V2 在 V1 之上增加真实层级、连续 primitive 与受控 PBR material。
 */
import { MODEL_SCRIPT_SCENE_IR_V2_VERSION } from "../model-script.js";
import type { Vec3 } from "../model-transform.js";

export const SCENE_IR_V2_VERSION = MODEL_SCRIPT_SCENE_IR_V2_VERSION;

/** 资源上限（至少与 V1 同量级，并新增 V2 专属预算）。 */
export const SCENE_IR_V2_MAX_OPS = 4096;
export const SCENE_IR_V2_MAX_MATERIALS = 256;
export const SCENE_IR_V2_MAX_HIERARCHY_DEPTH = 16;
export const SCENE_IR_V2_MAX_MESH_VERTICES = 65_000;
export const SCENE_IR_V2_MAX_MESH_FACES = 130_000;
export const SCENE_IR_V2_MAX_TOTAL_MESH_VERTICES = 200_000;
export const SCENE_IR_V2_MAX_TOTAL_MESH_FACES = 400_000;
/** 估算 tessellation 顶点预算：由 primitive 数量 × 固定质量档推导，不能靠海量 op 绕过。 */
export const SCENE_IR_V2_MAX_ESTIMATED_VERTICES = 200_000;
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
};

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
export type SceneV2MeshOp = SceneV2ShapeBase & { t: "mesh"; vertices: Vec3[]; faces: number[][] };
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
