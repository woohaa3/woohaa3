/**
 * Agent Plan 编译器：类型定义
 * （自 `planner.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R28）。
 */
import type {
  AgentCanvasError,
  AgentEntityRef,
  AgentNormalizedOperation,
  AgentPlanOperation,
  AgentPrecondition,
  AgentSemanticKind,
  CanvasCommand,
  Woohaa3CanvasSerializedNode
} from "@woohaa3/contracts";

/**
 * 编译所需的**只读**画布快照。
 *
 * 由 MCP 通过 Canvas 内部 graph 读取获得；只需要 planner 决策所需字段，不需要 Yjs/asset/credential。
 */
export type PlannerSnapshot = {
  rootGroupId?: string;
  canvasId: string;
  revision: number;
  nodes: ReadonlyArray<Pick<Woohaa3CanvasSerializedNode, "id" | "type" | "position" | "width" | "height" | "parentId"> & { retainWhenEmpty?: boolean }>;
  edges: ReadonlyArray<{ id: string; source: string; target: string }>;
};

export type PlanScope =
  | "validate_canvas_plan"
  | "apply_canvas_plan"
  | "create_canvas_node"
  | "connect_canvas_nodes"
  | "set_node_prompt"
  | "delete_canvas_entities";

export type PlanCompileInput = {
  canvasId: string;
  /** 写工具的显式 requestId（调用身份）。 */
  requestId: string;
  /** tool/plan scope；进入 command identity，避免不同工具复用同一 requestId 冲突。 */
  scope: PlanScope;
  operations: readonly AgentPlanOperation[];
  snapshot: PlannerSnapshot;
};

export type CompiledEntityRef = {
  ref: string;
  kind: AgentSemanticKind | null;
  canonicalType: string;
  nodeId?: string;
  edgeId?: string;
};

export type PlanCompileResult =
  | {
      ok: true;
      commands: CanvasCommand[];
      /** 与 commands 对应、在 Canvas 权威快照上于提交前复核的局部前置条件。 */
      preconditions: AgentPrecondition[];
      /** plan-local ref → canonical 实体 ID。 */
      refs: Record<string, string>;
      entities: CompiledEntityRef[];
      /** 规范化计划（含 resolvedId），用于 dry-run 回显。 */
      normalized: AgentNormalizedOperation[];
      warnings: string[];
      basisRevision: number;
      commandId: string;
      payloadHash: string;
    }
  | { ok: false; error: AgentCanvasError };

export type DeclaredEntity =
  | { kind: "node"; canonicalType: string; nodeId: string }
  | { kind: "edge"; canonicalType: string; edgeId: string };

/** planner 内部使用的实体引用（与 `AgentEntityRef` 同形）。 */
export type PlannerEntityRef = AgentEntityRef;
