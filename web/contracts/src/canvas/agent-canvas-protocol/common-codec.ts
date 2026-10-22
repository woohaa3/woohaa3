/**
 * Agent Canvas 公共协议：严格 codec 共享原语
 * （自 `agent-canvas-protocol.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R21）。
 */
import { isBoundedId, isFiniteNumber, isJsonObject } from "../../validation.js";
import { AGENT_CANVAS_LIMITS, type AgentDecodeResult, type AgentEntityRef, type AgentPosition } from "./types.js";

export type AgentDecodeLocation = { operationIndex?: number; field?: string };

export function decodeFail(
  code: string,
  message: string,
  location: AgentDecodeLocation = {}
): AgentDecodeResult<never> {
  return { ok: false, code, message, ...location };
}

/** 检查对象只包含白名单键；出现未知键即拒绝（严格 schema）。 */
export function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: AgentDecodeLocation = {}
): AgentDecodeResult<true> {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) {
    return decodeFail("malformed-request", `未知字段 ${unknown}`, { ...location, field: unknown });
  }
  return { ok: true, value: true };
}

export function readEntityRef(raw: unknown, location: AgentDecodeLocation): AgentDecodeResult<AgentEntityRef> {
  if (!isJsonObject(raw)) return decodeFail("malformed-request", "实体引用必须是对象", location);
  const hasRef = raw.ref !== undefined;
  const hasNodeId = raw.nodeId !== undefined;
  if (hasRef === hasNodeId) {
    return decodeFail("malformed-request", "实体引用必须且只能提供 ref 或 nodeId 之一", location);
  }
  if (hasRef) {
    if (!isBoundedId(raw.ref)) return decodeFail("malformed-request", "ref 必须是非空字符串", location);
    return { ok: true, value: { ref: raw.ref } };
  }
  if (!isBoundedId(raw.nodeId)) return decodeFail("malformed-request", "nodeId 必须是非空字符串", location);
  return { ok: true, value: { nodeId: raw.nodeId } };
}

export function readPosition(raw: unknown, location: AgentDecodeLocation): AgentDecodeResult<AgentPosition> {
  if (!isJsonObject(raw)) return decodeFail("malformed-request", "position 必须是对象", location);
  if (!isFiniteNumber(raw.x) || !isFiniteNumber(raw.y)) {
    return decodeFail("malformed-request", "position.x/y 必须是有限数值", location);
  }
  if (Math.abs(raw.x) > AGENT_CANVAS_LIMITS.maxPositionAbs || Math.abs(raw.y) > AGENT_CANVAS_LIMITS.maxPositionAbs) {
    return decodeFail("malformed-request", "position 超出画布坐标边界", location);
  }
  return { ok: true, value: { x: raw.x, y: raw.y } };
}

export { isBoundedId, isFiniteNumber, isJsonObject };
