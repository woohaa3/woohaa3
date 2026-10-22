/**
 * Canvas Script 公共协议：类型与错误模型
 * （change: 2026-10-13-add-canvas-script-authoring，任务 1.1 / 1.2 / design D2、D3、D7）。
 *
 * 外部 Agent 经 MCP 提交一次性版本化脚本时使用的**无副作用**契约：请求、预检回执、
 * 提交回执与阶段化结构化错误。脚本源码本身绝不进入任何 DTO 的持久化字段。
 *
 * 关键不变式：
 * - 计划 operation 复用既有 `AgentPlanOperation`（不新增第二套语义）；
 * - 错误携带稳定 code/stage 与可获得定位（line/column/operationIndex/api/field），**不含源码片段**；
 * - 回执与既有 `AgentMutationReceipt` 同形，附加 `version`/`submissionHash`/实际删除 identity。
 */
import type { AgentNormalizedOperation, AgentPrecondition } from "../agent-canvas-protocol.js";
import type { AgentApplyEdge, AgentApplyEntity } from "../agent-canvas-internal.js";
import type { CanvasScriptVersion } from "./limits.js";

/** 可用的 Canvas API 名称（顶层同步调用注入的 `canvas` API）。 */
export const CANVAS_SCRIPT_API_NAMES = [
  "node",
  "existing",
  "connect",
  "move",
  "setPrompt",
  "remove",
  "group",
  "reparent",
  "ungroup",
  "setTitle",
  "layout"
] as const;

export type CanvasScriptApiName = (typeof CANVAS_SCRIPT_API_NAMES)[number];

/** handle 种类：节点与边区分，边不能作节点参数。 */
export type CanvasScriptHandleKind = "node" | "edge";

/** 脚本对单一 target 的局部前置条件（沿用既有条件种类，不新增）。 */
export type CanvasScriptPrecondition = AgentPrecondition;

/** 提交身份：principal + canvas + 工具 scope + requestId（design D6）。 */
export type CanvasScriptIdentity = {
  principalId: string;
  canvasId: string;
  requestId: string;
  version: CanvasScriptVersion;
};

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

/**
 * 预检 / 提交请求。
 *
 * `version` 与 `requestId` 必填；`expectedRevision` 为可选全局条件。
 * 请求刻意不带任何提交凭证：身份与写权限由 MCP 连接期的受认证 principal 与资源策略负责。
 */
export type CanvasScriptRequest = {
  canvasId: string;
  requestId: string;
  version: string;
  source: string;
  expectedRevision?: number;
};

// ---------------------------------------------------------------------------
// 回执
// ---------------------------------------------------------------------------

/** 预检回执：不登记 requestId、不持久化源码、不推进 revision。 */
export type CanvasScriptValidateReceipt = {
  ok: true;
  protocolVersion: number;
  version: CanvasScriptVersion;
  canvasId: string;
  basisRevision: number;
  normalized: AgentNormalizedOperation[];
  refs: Record<string, string>;
  warnings: string[];
  /** 预计布局（plan-local ref → canonical 位置）；提交时按最新状态可能变化。 */
  predicted: Record<string, { x: number; y: number }>;
  organization?: import("./organization.js").CanvasOrganization;
};

/** 提交回执：冻结的首次结果，可从 durable receipt 重放。 */
export type CanvasScriptSubmitReceipt = {
  ok: true;
  protocolVersion: number;
  version: CanvasScriptVersion;
  canvasId: string;
  requestId: string;
  /** 不含源码的提交哈希（version + source + expectedRevision 的 SHA-256）。 */
  submissionHash: string;
  revision: number;
  duplicate: boolean;
  noop: boolean;
  refs: Record<string, string>;
  nodes: AgentApplyEntity[];
  edges: AgentApplyEdge[];
  /** 级联删除实际影响的节点/边 ID（首次提交冻结）。 */
  deletedNodeIds: string[];
  deletedEdgeIds: string[];
  organization?: import("./organization.js").CanvasOrganization;
};

// ---------------------------------------------------------------------------
// 阶段化错误
// ---------------------------------------------------------------------------

/** 错误阶段：定位失败发生在链路的哪一段。 */
export const CANVAS_SCRIPT_ERROR_STAGES = [
  "decode",
  "compile",
  "record",
  "authorize",
  "precondition",
  "commit"
] as const;

export type CanvasScriptErrorStage = (typeof CANVAS_SCRIPT_ERROR_STAGES)[number];

/** 稳定脚本错误码（MCP 与 Canvas 内部协议共用）。 */
export const CANVAS_SCRIPT_ERROR_CODES = [
  "malformed-request",
  "unsupported-version",
  "script-limit-exceeded",
  "script-timeout",
  "script-memory-limit",
  "script-runtime-error",
  "non-deterministic",
  "unknown-ref",
  "invalid-ref",
  "unknown-node",
  "unsupported-node-kind",
  "invalid-connection",
  "duplicate-edge",
  "unsupported-placement",
  "duplicate-ref",
  "entity-id-collision",
  "precondition-failed",
  "revision-conflict",
  "request-id-reused",
  "forbidden",
  "unauthorized",
  "canvas-not-found",
  "canvas-unavailable",
  "script-unavailable",
  "storage-failed",
  "rate-limited",
  "busy"
] as const;

export type CanvasScriptErrorCode = (typeof CANVAS_SCRIPT_ERROR_CODES)[number];

export type CanvasScriptError = {
  code: string;
  stage: CanvasScriptErrorStage;
  message: string;
  retryable: boolean;
  /** 可获得时提供 1-based 行列；源码不可回显。 */
  line?: number;
  column?: number;
  operationIndex?: number;
  /** 触发错误的 API 名称。 */
  api?: string;
  field?: string;
  suggestion?: string;
  currentRevision?: number;
};

export function canvasScriptError(
  code: string,
  stage: CanvasScriptErrorStage,
  message: string,
  options: {
    retryable?: boolean;
    line?: number;
    column?: number;
    operationIndex?: number;
    api?: string;
    field?: string;
    suggestion?: string;
    currentRevision?: number;
  } = {}
): CanvasScriptError {
  const { retryable, ...rest } = options;
  return { code, stage, message, retryable: retryable ?? false, ...rest };
}
