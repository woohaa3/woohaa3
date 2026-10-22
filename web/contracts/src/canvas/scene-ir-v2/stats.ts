/**
 * Scene IR V2 模型规模统计（点数 / 面数 / 对象数）
 * （change: 2026-10-18-simplify-model-focus-panel；
 *  change: 2026-10-18-align-model-statistics-with-agent —— 增加按几何种类的明细，
 *  供 MCP 工具把与聚焦面板同源的数字交给 Agent，避免各自手算）。
 *
 * 供模型聚焦信息面板与 MCP `get_model_statistics` 展示**作者内容规模**，不做 GPU 实测：
 * 数值与运行时 High 档的固定细分一致（`bevy/src/model3d/mesh.rs` 的三角面表与
 * `QUALITY_VERTEX_COUNTS`），自定义 mesh 使用作者声明的顶点/面。纯函数、无副作用，
 * 不读 Store、不执行脚本。
 */
import { V2_SHAPE_OPS, estimatePrimitiveVertices, type SceneV2Op, type SceneV2SolidOp } from "./types.js";

/**
 * 单个 primitive 在 **High 档** 的三角面数。
 *
 * 与 `bevy_overview_tier_triangles_match_tool_table` 锁定的运行时细分一致；`segment` 复用
 * box / capsule。自定义 mesh 不走此表。
 */
export const PRIMITIVE_TRIANGLE_COUNTS = {
  box: 12,
  sphere: 528,
  cylinder: 92,
  capsule: 288
} as const;

export type ModelSceneStatistics = {
  /** 实体对象数（box/cylinder/sphere/capsule/mesh/segment；不含 group/material/animation）。 */
  objects: number;
  /** 分组数。 */
  groups: number;
  /** 估算渲染顶点数（High 档；自定义 mesh 取作者顶点数）。 */
  vertices: number;
  /** 估算三角面数（High 档；自定义 mesh 按扇形三角化）。 */
  triangles: number;
  /** 材质数。 */
  materials: number;
  /** 动画数。 */
  animations: number;
};

/** 单种几何对规模的贡献（`segment` 按自身 shape 归为 box 或 capsule）。 */
export type ModelSceneKindStatistics = {
  count: number;
  vertices: number;
  triangles: number;
};

/** 按实际几何种类拆分的明细；用于解释点数主要来自哪里。 */
export type ModelSceneStatisticsBreakdown = {
  box: ModelSceneKindStatistics;
  cylinder: ModelSceneKindStatistics;
  sphere: ModelSceneKindStatistics;
  capsule: ModelSceneKindStatistics;
  mesh: ModelSceneKindStatistics;
};

export type ModelSceneStatisticsDetail = {
  statistics: ModelSceneStatistics;
  breakdown: ModelSceneStatisticsBreakdown;
};

function emptyKind(): ModelSceneKindStatistics {
  return { count: 0, vertices: 0, triangles: 0 };
}

function emptyBreakdown(): ModelSceneStatisticsBreakdown {
  return {
    box: emptyKind(),
    cylinder: emptyKind(),
    sphere: emptyKind(),
    capsule: emptyKind(),
    mesh: emptyKind()
  };
}

/** 按规范 ops 统计模型规模及种类明细。空场景返回全零。 */
export function modelSceneStatisticsDetail(ops: readonly SceneV2Op[]): ModelSceneStatisticsDetail {
  const statistics: ModelSceneStatistics = {
    objects: 0,
    groups: 0,
    vertices: 0,
    triangles: 0,
    materials: 0,
    animations: 0
  };
  const breakdown = emptyBreakdown();
  for (const op of ops) {
    if (op.t === "material") {
      statistics.materials += 1;
      continue;
    }
    if (op.t === "oscillate" || op.t === "move" || op.t === "rotate") {
      statistics.animations += 1;
      continue;
    }
    if (op.t === "group") {
      statistics.groups += 1;
      continue;
    }
    if (!isSolid(op)) continue;
    const vertices = estimatePrimitiveVertices(op);
    const triangles = solidTriangles(op);
    statistics.objects += 1;
    statistics.vertices += vertices;
    statistics.triangles += triangles;
    const kind = solidKind(op);
    breakdown[kind].count += 1;
    breakdown[kind].vertices += vertices;
    breakdown[kind].triangles += triangles;
  }
  return { statistics, breakdown };
}

/** 按规范 ops 统计模型规模。空场景返回全零。 */
export function modelSceneStatistics(ops: readonly SceneV2Op[]): ModelSceneStatistics {
  return modelSceneStatisticsDetail(ops).statistics;
}

/** 承载几何的 solid（`t` 为 shape 且非 group）；其余 op 不计入规模。 */
function isSolid(op: SceneV2Op): op is SceneV2SolidOp {
  return V2_SHAPE_OPS.has(op.t) && op.t !== "group";
}

/** `segment` 按自身 shape 归入 box / capsule；其余按 `t`。 */
function solidKind(op: SceneV2SolidOp): keyof ModelSceneStatisticsBreakdown {
  if (op.t === "segment") return op.shape === "capsule" ? "capsule" : "box";
  return op.t;
}

/** 单个实体的估算三角面数（High 档；mesh 按扇形三角化）。 */
function solidTriangles(op: SceneV2SolidOp): number {
  switch (op.t) {
    case "mesh":
      return op.faces.reduce((total, face) => total + Math.max(0, face.length - 2), 0);
    case "segment":
      return op.shape === "capsule" ? PRIMITIVE_TRIANGLE_COUNTS.capsule : PRIMITIVE_TRIANGLE_COUNTS.box;
    case "box":
      return PRIMITIVE_TRIANGLE_COUNTS.box;
    case "sphere":
      return PRIMITIVE_TRIANGLE_COUNTS.sphere;
    case "cylinder":
      return PRIMITIVE_TRIANGLE_COUNTS.cylinder;
    case "capsule":
      return PRIMITIVE_TRIANGLE_COUNTS.capsule;
    default:
      return 0;
  }
}
