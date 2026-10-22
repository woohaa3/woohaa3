/**
 * Agent Canvas 公共协议：类型与常量
 * （自 `agent-canvas-protocol.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R21）。
 *
 * 纯类型/常量叶子。外部 Agent 经 MCP 读图、验证并原子建图的类型化、版本化、无副作用契约。
 */
import type { CanvasNodeTaskStatus } from "../../task/dto.js";
import type { AgentSemanticKind } from "../agent-node-descriptors.js";

/** Agent Canvas 对外协议版本；任何不兼容结构变化都要提升它。 */
export const AGENT_CANVAS_PROTOCOL_VERSION = 1 as const;
export type AgentCanvasProtocolVersion = typeof AGENT_CANVAS_PROTOCOL_VERSION;

/** 协议 limits：能力响应与校验共用同一事实源（design D4）。 */
export const AGENT_CANVAS_LIMITS = {
  /** prompt 字符上限（与任务协议一致）。 */
  promptMaxChars: 8000,
  /** 单个计划 operation 数上限。 */
  maxPlanOperations: 256,
  /** 单页 graph 节点上限。 */
  maxGraphNodes: 200,
  /** 单页 graph 边上限。 */
  maxGraphEdges: 400,
  /** 邻域读取默认与最大深度。 */
  defaultNeighborhoodDepth: 1,
  maxNeighborhoodDepth: 4,
  /** response 内嵌文本上限（超出需缩小查询）。 */
  maxResponseTextChars: 200_000,
  /** 单节点位置坐标绝对上限（画布世界坐标边界）。 */
  maxPositionAbs: 1_000_000,
  /** 自动布局固定间距（与网格吸附同量级）。 */
  titleMaxChars: 200,
  maxAffectedNodes: 256,
  maxDerivedCommands: 1024,
  maxGridColumns: 256,
  layoutGap: 40
} as const;

/** placement 模式。 */
export type AgentPlacementMode = "absolute" | "auto" | "after" | "before" | "below";

export const AGENT_PLACEMENT_MODES: readonly AgentPlacementMode[] = [
  "absolute",
  "auto",
  "after",
  "before",
  "below"
];

export type AgentPosition = { x: number; y: number };

/** 计划内可被后续 operation 引用的实体：plan-local `ref` 或已存在 `nodeId`（二者互斥）。 */
export type AgentEntityRef = { ref: string } | { nodeId: string };

export type AgentCreatePlacement =
  | { mode: "absolute"; position: AgentPosition }
  | { mode: "auto" }
  | { mode: "after"; anchor: AgentEntityRef; gap?: number }
  | { mode: "before"; anchor: AgentEntityRef; gap?: number }
  | { mode: "below"; anchor: AgentEntityRef; gap?: number };

/** 局部前置条件（design D9）。 */
export type AgentPrecondition =
  | { type: "node-exists"; nodeId: string }
  | { type: "node-missing"; nodeId: string }
  | { type: "prompt-equals"; nodeId: string; equals: string }
  | { type: "not-processing"; nodeId: string };

export type AgentGridLayout = { mode: "grid"; columns: number; gapX?: number; gapY?: number; origin?: AgentPosition };

export type AgentPlanOperation =
  | { op: "create_group"; ref: string; title: string; members: AgentEntityRef[]; layout?: AgentGridLayout; placement?: AgentCreatePlacement; if?: AgentPrecondition }
  | { op: "reparent"; targets: AgentEntityRef[]; parent: AgentEntityRef | null; if?: AgentPrecondition }
  | { op: "ungroup"; target: AgentEntityRef; if?: AgentPrecondition }
  | { op: "set_title"; target: AgentEntityRef; title: string; if?: AgentPrecondition }
  | { op: "layout"; targets: AgentEntityRef[]; layout: AgentGridLayout; if?: AgentPrecondition }
  | {
      op: "create_node";
      /** plan-local ref；后续 operation 通过它引用新节点。 */
      ref: string;
      kind: AgentSemanticKind;
      title?: string;
      prompt?: string;
      placement?: AgentCreatePlacement;
    }
  | {
      op: "connect";
      ref: string;
      from: AgentEntityRef;
      to: AgentEntityRef;
      label?: string;
      if?: AgentPrecondition;
    }
  | {
      op: "set_prompt";
      target: AgentEntityRef;
      prompt: string;
      if?: AgentPrecondition;
    }
  | {
      op: "move_node";
      coordinateSpace?: "parent" | "world";
      target: AgentEntityRef;
      position: AgentPosition;
      if?: AgentPrecondition;
    }
  | {
      op: "delete";
      targets: AgentEntityRef[];
      if?: AgentPrecondition;
    };

/** 规范化后的 operation（planner 填充确定性实体 ID 后返回；dry-run 回显用）。 */
export type AgentNormalizedOperation = AgentPlanOperation & {
  /** create_node：确定性 nodeId；connect：确定性 edgeId。 */
  resolvedId?: string;
};

// ---------------------------------------------------------------------------
// 图投影 / 增量
// ---------------------------------------------------------------------------

export type AgentNodeAffordances = {
  canSetPrompt: boolean;
  canRun: boolean;
  canConnect: boolean;
  canDelete: boolean;
  canMove?: boolean;
  canGroup?: boolean;
  canReparent?: boolean;
  canUngroup?: boolean;
  canSetTitle?: boolean;
};

export type AgentInputSummary = {
  sourceNodeId: string;
  role: string;
  label?: string;
};

export type AgentCanvasNodeProjection = {
  nodeId: string;
  /** 语义种类；未知 canonical 类型回退为 `null` 并保留 canonicalType。 */
  kind: AgentSemanticKind | null;
  canonicalType: string;
  parentId?: string | null;
  worldBounds?: { x: number; y: number; width: number; height: number };
  directMemberCount?: number | null;
  position: AgentPosition;
  /** Effective displayed card/base dimensions, shared with rendering and layout. */
  size: { width: number; height: number };
  title?: string;
  prompt?: string;
  task?: {
    taskKind?: string;
    taskStatus?: CanvasNodeTaskStatus;
    progress?: number;
    runId?: string;
  };
  inputs?: AgentInputSummary[];
  affordances: AgentNodeAffordances;
};

export type AgentCanvasEdgeProjection = {
  edgeId: string;
  source: string;
  target: string;
  label?: string;
};

export type AgentCanvasGraph = {
  /** Trusted host projection only; an execution grant is never accepted from tool arguments. */
  rootGroupId?: string;
  protocolVersion: AgentCanvasProtocolVersion;
  canvasId: string;
  title: string;
  revision: number;
  nodes: AgentCanvasNodeProjection[];
  edges: AgentCanvasEdgeProjection[];
  /** 是否因 limit/字段裁剪而未返回完整图。 */
  truncated: boolean;
  /** 同一 revision 的继续读取游标；无更多页时省略。 */
  nextCursor?: string;
};

export type AgentCanvasDelta = {
  protocolVersion: AgentCanvasProtocolVersion;
  canvasId: string;
  fromRevision: number;
  currentRevision: number;
  nodes: AgentCanvasNodeProjection[];
  edges: AgentCanvasEdgeProjection[];
  deletedNodeIds: string[];
  deletedEdgeIds: string[];
  /** 起始 revision 已不在保留窗口内时，必须重新读取 snapshot。 */
  resetRequired: boolean;
};

// ---------------------------------------------------------------------------
// canonical 回执
// ---------------------------------------------------------------------------

export type AgentEntitySummary = {
  kind: AgentSemanticKind | null;
  canonicalType: string;
  title?: string;
  prompt?: string;
  parentId?: string | null;
  worldBounds?: { x: number; y: number; width: number; height: number };
  directMemberCount?: number | null;
  position: AgentPosition;
  /** Effective displayed card/base dimensions, shared with rendering and layout. */
  size: { width: number; height: number };
};

export type AgentEdgeSummary = {
  source: string;
  target: string;
  label?: string;
};

export type AgentMutationReceipt = {
  ok: true;
  protocolVersion: AgentCanvasProtocolVersion;
  canvasId: string;
  requestId: string;
  revision: number;
  duplicate: boolean;
  noop: boolean;
  /** plan-local ref → canonical 实体 ID（create_node/connect）。 */
  refs: Record<string, string>;
  nodes: Array<{ nodeId: string } & AgentEntitySummary>;
  edges: Array<{ edgeId: string } & AgentEdgeSummary>;
};

export type AgentValidateReceipt = {
  ok: true;
  protocolVersion: AgentCanvasProtocolVersion;
  canvasId: string;
  basisRevision: number;
  normalized: AgentNormalizedOperation[];
  refs: Record<string, string>;
  warnings: string[];
  /** 有界有效的 validation token；传入 apply 时绑定该 revision。 */
  validationToken?: string;
};

// ---------------------------------------------------------------------------
// 结构化错误
// ---------------------------------------------------------------------------

export type AgentCanvasError = {
  code: string;
  message: string;
  retryable: boolean;
  operationIndex?: number;
  field?: string;
  suggestion?: string;
  currentRevision?: number;
  details?: Record<string, unknown>;
};

export function agentCanvasError(
  code: string,
  message: string,
  options: Omit<AgentCanvasError, "code" | "message" | "retryable"> & { retryable?: boolean } = {}
): AgentCanvasError {
  return { code, message, retryable: options.retryable ?? false, ...stripRetryable(options) };
}

function stripRetryable<T extends { retryable?: boolean }>(options: T): Omit<T, "retryable"> {
  const { retryable: _retryable, ...rest } = options;
  return rest;
}

// ---------------------------------------------------------------------------
// 能力发现
// ---------------------------------------------------------------------------

export type AgentNodeCapability = {
  kind: AgentSemanticKind;
  canonicalType: string;
  label: string;
  supportsPrompt: boolean;
  executable: boolean;
  defaultSize: { width: number; height: number };
};

export type AgentScriptCapability = {
  available: boolean;
  /** 可用时：默认脚本版本、受支持版本、指南工具、预算与「不保存源码」提交语义。 */
  version?: string;
  versions?: string[];
  guideTool?: string;
  limits?: Record<string, number | string | boolean>;
  /** 源码不写入画布/持久层（提交语义事实）。 */
  sourcePersisted?: false;
  /** 不可用原因（fail-closed 显式标注，不静默消失）。 */
  reason?: string;
};

export type AgentCanvasCapabilities = {
  protocolVersion: AgentCanvasProtocolVersion;
  /** 省略 canvasId 时为全局能力（尚未绑定画布）。 */
  canvasId?: string;
  nodeKinds: AgentNodeCapability[];
  operations: readonly string[];
  placementModes: readonly AgentPlacementMode[];
  limits: typeof AGENT_CANVAS_LIMITS;
  /** 推荐调用顺序（discover -> inspect -> validate -> apply -> run）。 */
  recommendedFlow?: readonly string[];
  run: { available: boolean; reason?: string };
  /** 版本化脚本能力（change: 2026-10-13-add-canvas-script-authoring）。 */
  script?: AgentScriptCapability;
  grouping?: { available: boolean; operations: string[] };
  layout?: { available: boolean; modes: string[]; coordinateSpace: "world" };
  models?: { available: boolean; reason?: string; items: unknown[] };
};

// ---------------------------------------------------------------------------
// 严格 codec 结果类型
// ---------------------------------------------------------------------------

export type AgentDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string; operationIndex?: number; field?: string };
