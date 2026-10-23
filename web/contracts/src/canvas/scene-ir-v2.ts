/**
 * `woohaa-model-scene-ir-v2` 运行时 DTO、validator、extent 与 signature 公共入口
 * （change: enhance-model-scene-authoring-api，任务 1.2 / 2.2 / 2.3 / 2.4；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility R14 —— 拆分为
 *  类型/上限、reader、validator、bounds/signature 子模块）。
 *
 * V2 在 V1 之上增加真实层级、连续 primitive 与受控 PBR material。与 V1 一样，Scene IR 只是
 * 发送给执行器的运行时 DTO，**不写入**规范 Y.Doc，也不替代 `modelScript`。validator 是无副作用
 * 纯函数，浏览器 executor、Canvas Service 与 Rust 边界校验共用同一套规范化结果。
 *
 * 本文件为稳定 barrel：显式导出既有公共 API（不含内部 reader 工具），实现分别在
 * `scene-ir-v2/` 子模块，内部直接导入叶子模块。
 */

// 类型、上限常量与错误码。
export {
  SCENE_IR_V2_VERSION,
  SCENE_IR_V2_MAX_MESH_VERTICES,
  SCENE_IR_V2_MAX_MESH_FACES,
  SCENE_IR_V2_COORD_LIMIT,
  SCENE_IR_V2_MIN_SEGMENT_LENGTH,
  SCENE_IR_V2_MAX_EMISSIVE_STRENGTH,
  PRIMITIVE_QUALITY,
  estimatePrimitiveVertices,
  type SceneV2MaterialAlphaMode,
  type SceneV2MaterialOp,
  type SceneV2ShapeBase,
  type SceneV2GroupOp,
  type SceneV2BoxOp,
  type SceneV2CylinderOp,
  type SceneV2SphereOp,
  type SceneV2CapsuleOp,
  type SceneV2MeshOp,
  type SceneV2SegmentOp,
  type SceneV2SolidOp,
  type SceneV2ShapeOp,
  type SceneV2AnimationOp,
  type SceneV2Op,
  type ModelSceneIrV2,
  type SceneIrV2Validation,
  type SceneIrErrorCode,
  type SceneIrV2ErrorCode
} from "./scene-ir-v2/types.js";

// 全局 validator。
export { validateModelSceneIrV2 } from "./scene-ir-v2/validator.js";

// AABB/extent/signature 与确定性颜色归一化。
export { v2SceneAabb, v2SceneExtent, v2ExtentFromAabb, v2SceneSignature } from "./scene-ir-v2/bounds.js";

// 模型规模统计（点数/面数/对象数，模型聚焦信息面板与 MCP 统计工具共用）。
export {
  modelSceneStatistics,
  modelSceneStatisticsDetail,
  PRIMITIVE_TRIANGLE_COUNTS,
  type ModelSceneStatistics,
  type ModelSceneStatisticsDetail,
  type ModelSceneStatisticsBreakdown,
  type ModelSceneKindStatistics
} from "./scene-ir-v2/stats.js";
export { normalizeHex } from "./scene-ir-v2/reader.js";
