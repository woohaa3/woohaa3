/**
 * Agent Canvas 公共协议：query / requestId 解码
 * （自 `agent-canvas-protocol.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R21）。
 */
import { isBoundedId, isNonNegativeInteger, isJsonObject } from "../../validation.js";
import { AGENT_CANVAS_LIMITS, type AgentDecodeResult } from "./types.js";
import { assertKnownKeys, decodeFail } from "./common-codec.js";

/** 解码 requestId（写工具必需，非空且有界）。 */
export function decodeAgentRequestId(raw: unknown): AgentDecodeResult<string> {
  if (!isBoundedId(raw)) return { ok: false, code: "malformed-request", message: "requestId 必须是非空字符串", field: "requestId" };
  return { ok: true, value: raw };
}

export type AgentGraphQuery = {
  parentId?: string | null;
  nodeIds?: string[];
  aroundNodeId?: string;
  depth?: number;
  includePrompt?: boolean;
  limit?: number;
  cursor?: string;
};

/** 解码 graph 读取查询；未知字段拒绝。 */
export function decodeAgentGraphQuery(raw: unknown): AgentDecodeResult<AgentGraphQuery> {
  if (raw === undefined) return { ok: true, value: {} };
  if (!isJsonObject(raw)) return decodeFail("malformed-request", "graph 查询必须是对象");
  const known = assertKnownKeys(raw, ["parentId", "nodeIds", "aroundNodeId", "depth", "includePrompt", "limit", "cursor"]);
  if (!known.ok) return known;
  const query: AgentGraphQuery = {};
  if (raw.parentId !== undefined) {
    if (raw.parentId !== null && !isBoundedId(raw.parentId)) return decodeFail("malformed-request", "parentId 必须是节点 ID 或 null", { field: "parentId" });
    if (raw.nodeIds !== undefined || raw.aroundNodeId !== undefined) return decodeFail("malformed-request", "parentId 与 nodeIds/aroundNodeId 互斥", { field: "parentId" });
    query.parentId = raw.parentId as string | null;
  }
  if (raw.nodeIds !== undefined) {
    if (!Array.isArray(raw.nodeIds) || raw.nodeIds.some((id) => !isBoundedId(id))) {
      return decodeFail("malformed-request", "nodeIds 必须是非空字符串数组", { field: "nodeIds" });
    }
    query.nodeIds = raw.nodeIds as string[];
  }
  if (raw.aroundNodeId !== undefined) {
    if (!isBoundedId(raw.aroundNodeId)) return decodeFail("malformed-request", "aroundNodeId 必须是非空字符串", { field: "aroundNodeId" });
    query.aroundNodeId = raw.aroundNodeId;
  }
  if (raw.depth !== undefined) {
    if (!isNonNegativeInteger(raw.depth) || raw.depth > AGENT_CANVAS_LIMITS.maxNeighborhoodDepth) {
      return decodeFail("malformed-request", `depth 必须是 0..${AGENT_CANVAS_LIMITS.maxNeighborhoodDepth} 整数`, { field: "depth" });
    }
    query.depth = raw.depth;
  }
  if (raw.includePrompt !== undefined) {
    if (typeof raw.includePrompt !== "boolean") return decodeFail("malformed-request", "includePrompt 必须是布尔值", { field: "includePrompt" });
    query.includePrompt = raw.includePrompt;
  }
  if (raw.limit !== undefined) {
    if (!isNonNegativeInteger(raw.limit) || raw.limit === 0) return decodeFail("malformed-request", "limit 必须是正整数", { field: "limit" });
    query.limit = raw.limit;
  }
  if (raw.cursor !== undefined) {
    if (!isBoundedId(raw.cursor)) return decodeFail("malformed-request", "cursor 必须是非空字符串", { field: "cursor" });
    query.cursor = raw.cursor;
  }
  return { ok: true, value: query };
}

export type AgentChangesQuery = { sinceRevision: number; limit?: number };

export function decodeAgentChangesQuery(raw: unknown): AgentDecodeResult<AgentChangesQuery> {
  if (!isJsonObject(raw)) return decodeFail("malformed-request", "changes 查询必须是对象");
  const known = assertKnownKeys(raw, ["sinceRevision", "limit"]);
  if (!known.ok) return known;
  if (!isNonNegativeInteger(raw.sinceRevision)) {
    return decodeFail("malformed-request", "sinceRevision 必须是非负整数", { field: "sinceRevision" });
  }
  const query: AgentChangesQuery = { sinceRevision: raw.sinceRevision };
  if (raw.limit !== undefined) {
    if (!isNonNegativeInteger(raw.limit) || raw.limit === 0) return decodeFail("malformed-request", "limit 必须是正整数", { field: "limit" });
    query.limit = raw.limit;
  }
  return { ok: true, value: query };
}
