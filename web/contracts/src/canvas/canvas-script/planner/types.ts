/**
 * 共享纯计划编译器：类型
 * （自 `mcp-service/src/agent-authoring/planner-types.ts` 提取到 contracts，
 *  change: 2026-10-13-add-canvas-script-authoring，任务 1.3 / design D5）。
 *
 * 这是 MCP facade 与服务端脚本执行器共享的**纯**编译边界：只含类型、常量与纯函数，
 * 不 import 任何服务实现、Node 专属 API 或 Yjs。
 */
import type { CanvasCommand } from "../../commands.js";
import type {
  AgentCanvasError,
  AgentNormalizedOperation,
  AgentPlanOperation,
  AgentPrecondition
} from "../../agent-canvas-protocol.js";
import type { AgentSemanticKind } from "../../agent-node-descriptors.js";
import type { Woohaa3CanvasSerializedNode } from "../../domain/index.js";

/**
 * 编译所需的**只读**画布快照。
 *
 * 调用方（MCP 经内部协议、Canvas 脚本服务经权威 room）负责提供；planner 不读取权威。
 */
export type PlannerSnapshot = {
  rootGroupId?: string;
  canvasId: string;
  revision: number;
  nodes: ReadonlyArray<Pick<Woohaa3CanvasSerializedNode, "id" | "type" | "position" | "width" | "height" | "parentId"> & { title?: string; retainWhenEmpty?: boolean }>;
  edges: ReadonlyArray<{ id: string; source: string; target: string }>;
};

/** 计划 scope：进入 command identity，避免不同工具复用同一 requestId 冲突。 */
export type PlanScope =
  | "validate_canvas_plan"
  | "apply_canvas_plan"
  | "create_canvas_node"
  | "connect_canvas_nodes"
  | "set_node_prompt"
  | "delete_canvas_entities"
  | "submit_canvas_script";

export type PlanCompileInput = {
  canvasId: string;
  /** 写工具的显式 requestId（调用身份）。 */
  requestId: string;
  /** tool/plan scope；进入 command identity。 */
  scope: PlanScope;
  /**
   * 可信 principal（脚本提交身份的一部分）。
   *
   * 既有 JSON 工具路径省略时为 `""`，保持既有实体 ID 不漂移；脚本路径必须提供。
   */
  principalId?: string;
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
      organization: import("../organization.js").CanvasOrganization;
      finalNodes: PlannerSnapshot["nodes"];
      /** 与 commands 对应、在权威快照上于提交前复核的局部前置条件。 */
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
      /** plan-local ref → 预计规范位置（含同计划新建/移动后的节点）。 */
      predicted: Record<string, { x: number; y: number }>;
      /** 计划引用到的**既有** canonical 节点 ID（授权范围复核用）。 */
      touchedExistingNodeIds: string[];
    }
  | { ok: false; error: AgentCanvasError };

export type DeclaredEntity =
  | { kind: "node"; canonicalType: string; nodeId: string }
  | { kind: "edge"; canonicalType: string; edgeId: string };
