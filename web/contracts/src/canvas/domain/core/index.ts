/**
 * 画布中立核心（从来源项目收敛）。
 *
 * 该 barrel 只导出画布聚合契约所需的中立模块；来源 core 的生成模型目录、
 * prompt 片段、任务契约、执行图等均未纳入。
 *
 * `./canvas-runtime` 采用选择性再导出而非 `export *`：它与 `./document-schema`
 * 各有一份同名但语义不同的 `Woohaa3CanvasEdge`（前者是渲染器中立的运行时边，
 * 后者是持久化边）。整体 `export *` 会让该名字在 barrel 中变成歧义导出并被丢弃。
 */
export * from "./document-schema";

export type { Woohaa3CanvasNodeData,
  Woohaa3CanvasNode,
  Woohaa3CanvasConnection,
  Woohaa3CanvasSnapshot } from "./canvas-runtime";

export * from "./connection-adapters";
export * from "./composite-asset-identity";
export * from "./connection-rules";
export * from "./grid";
export * from "./group-ops";
export * from "./incoming-edges";
export * from "./input-role";
export * from "./input-role-contract";
export * from "./input-slots";
export * from "./mention-token";
export * from "./shot-reference";

export * from "./node-factory";
export * from "./node-removal";
export * from "./node-z-index";
export * from "./serialization";
export * from "./viewport-zoom";
