/**
 * Canvas Script 公共入口
 * （change: 2026-10-13-add-canvas-script-authoring，任务 1.1–1.4 / design D2–D7）。
 *
 * 版本化一次性画布脚本的无副作用契约：版本/预算、严格解码、请求与回执 DTO、阶段化错误，
 * 以及被 MCP 与 Canvas 服务共享的纯计划编译器。
 *
 * 刻意不在此聚合导出 `hashText`、`Rect` 等与既有模块同名的符号（避免 contracts 顶层
 * 重复导出）；需要它们的调用方直接从具体模块导入。
 */
export * from "./limits.js";
export * from "./types.js";
export * from "./decode.js";
export * from "./api-guide.js";
export * from "./submission.js";

// 纯计划编译器（不导出 hashText/Rect 以免顶层重名）。
export type {
  CompiledEntityRef,
  DeclaredEntity,
  PlanCompileInput,
  PlanCompileResult,
  PlanScope,
  PlannerSnapshot
} from "./planner/types.js";
export type { IndexedSnapshot, PlannedNode, PlacementState } from "./planner/placement.js";
export {
  compileAgentPlan,
  compileAgentPlanWithHash,
  defaultConnectLabel,
  hasEdge,
  indexSnapshot,
  resolveAnchorGeometry,
  resolvePlacement,
  sizeOf,
  rectOf
} from "./planner/compile.js";
export { deriveEntityId, hashPlanPayload, sha256Hex, stableStringify } from "./planner/hash.js";

export * from "./organization.js";
