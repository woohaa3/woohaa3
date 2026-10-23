/**
 * Agent Canvas 公共协议：计划 operation 严格解码
 * （自 `agent-canvas-protocol.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R21）。
 *
 * 在副作用前完成：未知字段、错误结构、非法 ref 形式都在此拒绝。引用是否存在/前向由 planner
 * 的 symbol table 判定（需要顺序语义）。
 */
import { readOrganizationOperation } from "./organization-codec.js";
import { isAgentSemanticKind } from "../agent-node-descriptors.js";
import {
  type AgentCreatePlacement,
  type AgentDecodeResult,
  type AgentPlanOperation,
  type AgentPrecondition
} from "./types.js";
import {
  assertKnownKeys,
  decodeFail,
  readEntityRef,
  readPosition,
  type AgentDecodeLocation
} from "./common-codec.js";
import { isBoundedId, isFiniteNumber, isJsonObject } from "../../validation.js";

/** 严格解码一个 plan operation 数组。 */
export function decodeAgentPlanOperations(raw: unknown): AgentDecodeResult<AgentPlanOperation[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return decodeFail("malformed-request", "operations 必须是非空数组", { field: "operations" });
  }
  // change: 2026-10-22-remove-agent-execution-limits，任务 5.1：不再按计划操作数拒绝；
  // 大计划完整解码后由同一 planner 校验并一次原子提交。
  const operations: AgentPlanOperation[] = [];
  for (const [operationIndex, entry] of raw.entries()) {
    const decoded = decodeAgentPlanOperation(entry, operationIndex);
    if (!decoded.ok) return decoded;
    operations.push(decoded.value);
  }
  return { ok: true, value: operations };
}

function decodeAgentPlanOperation(raw: unknown, operationIndex: number): AgentDecodeResult<AgentPlanOperation> {
  if (!isJsonObject(raw)) return decodeFail("malformed-request", "operation 必须是对象", { operationIndex });
  const op = raw.op;
  switch (op) {
    case "create_group":
    case "reparent":
    case "ungroup":
    case "set_title":
    case "layout": {
      const condition = raw.if === undefined ? undefined : readPrecondition(raw.if, { operationIndex, field: "if" });
      if (condition && !condition.ok) return condition;
      const { if: ignored, ...body } = raw;
      const decoded = readOrganizationOperation(body, operationIndex);
      if (!decoded.ok) return decoded;
      if (decoded.value.op === "create_group" && raw.placement !== undefined) {
        const place = readPlacement(raw.placement, { operationIndex, field: "placement" });
        if (!place.ok) return place;
        decoded.value.placement = place.value;
      }
      return { ok: true, value: { ...decoded.value, ...(condition?.ok ? { if: condition.value } : {}) } };
    }
    case "create_node": {
      const known = assertKnownKeys(raw, ["op", "ref", "kind", "title", "prompt", "placement"], { operationIndex });
      if (!known.ok) return known;
      if (!isBoundedId(raw.ref)) return decodeFail("malformed-request", "create_node.ref 必须是非空字符串", { operationIndex, field: "ref" });
      if (!isAgentSemanticKind(raw.kind)) {
        return decodeFail("unsupported-node-kind", `不支持的节点种类 ${String(raw.kind)}`, { operationIndex, field: "kind" });
      }
      if (raw.title !== undefined && typeof raw.title !== "string") {
        return decodeFail("malformed-request", "title 必须是字符串", { operationIndex, field: "title" });
      }
      if (raw.prompt !== undefined && typeof raw.prompt !== "string") {
        return decodeFail("malformed-request", "prompt 必须是字符串", { operationIndex, field: "prompt" });
      }
      const placement = readPlacement(raw.placement, { operationIndex, field: "placement" });
      if (!placement.ok) return placement;
      return {
        ok: true,
        value: {
          op: "create_node",
          ref: raw.ref,
          kind: raw.kind,
          ...(raw.title !== undefined ? { title: raw.title } : {}),
          ...(raw.prompt !== undefined ? { prompt: raw.prompt } : {}),
          placement: placement.value
        }
      };
    }
    case "connect": {
      const known = assertKnownKeys(raw, ["op", "ref", "from", "to", "label", "if"], { operationIndex });
      if (!known.ok) return known;
      if (!isBoundedId(raw.ref)) return decodeFail("malformed-request", "connect.ref 必须是非空字符串", { operationIndex, field: "ref" });
      const from = readEntityRef(raw.from, { operationIndex, field: "from" });
      if (!from.ok) return from;
      const to = readEntityRef(raw.to, { operationIndex, field: "to" });
      if (!to.ok) return to;
      if (raw.label !== undefined && typeof raw.label !== "string") {
        return decodeFail("malformed-request", "label 必须是字符串", { operationIndex, field: "label" });
      }
      const precondition = raw.if === undefined ? undefined : readPrecondition(raw.if, { operationIndex, field: "if" });
      if (precondition && !precondition.ok) return precondition;
      return {
        ok: true,
        value: {
          op: "connect",
          ref: raw.ref,
          from: from.value,
          to: to.value,
          ...(raw.label !== undefined ? { label: raw.label } : {}),
          ...(precondition ? { if: precondition.value } : {})
        }
      };
    }
    case "set_prompt": {
      const known = assertKnownKeys(raw, ["op", "target", "prompt", "if"], { operationIndex });
      if (!known.ok) return known;
      const target = readEntityRef(raw.target, { operationIndex, field: "target" });
      if (!target.ok) return target;
      if (typeof raw.prompt !== "string") return decodeFail("malformed-request", "prompt 必须是字符串", { operationIndex, field: "prompt" });
      const precondition = raw.if === undefined ? undefined : readPrecondition(raw.if, { operationIndex, field: "if" });
      if (precondition && !precondition.ok) return precondition;
      return {
        ok: true,
        value: { op: "set_prompt", target: target.value, prompt: raw.prompt, ...(precondition ? { if: precondition.value } : {}) }
      };
    }
    case "move_node": {
      if (raw.coordinateSpace !== undefined && raw.coordinateSpace !== "world" && raw.coordinateSpace !== "parent") return decodeFail("malformed-request", "未知 coordinateSpace", { operationIndex, field: "coordinateSpace" });
      const known = assertKnownKeys(raw, ["op", "target", "position", "coordinateSpace", "if"], { operationIndex });
      if (!known.ok) return known;
      const target = readEntityRef(raw.target, { operationIndex, field: "target" });
      if (!target.ok) return target;
      const position = readPosition(raw.position, { operationIndex, field: "position" });
      if (!position.ok) return position;
      const precondition = raw.if === undefined ? undefined : readPrecondition(raw.if, { operationIndex, field: "if" });
      if (precondition && !precondition.ok) return precondition;
      return {
        ok: true,
        value: { op: "move_node", target: target.value, position: position.value, ...(raw.coordinateSpace !== undefined ? { coordinateSpace: raw.coordinateSpace as "world" | "parent" } : {}), ...(precondition ? { if: precondition.value } : {}) }
      };
    }
    case "delete": {
      const known = assertKnownKeys(raw, ["op", "targets", "if"], { operationIndex });
      if (!known.ok) return known;
      if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
        return decodeFail("malformed-request", "delete.targets 必须是非空数组", { operationIndex, field: "targets" });
      }
      const targets = [];
      for (const entry of raw.targets) {
        const ref = readEntityRef(entry, { operationIndex, field: "targets" });
        if (!ref.ok) return ref;
        targets.push(ref.value);
      }
      const precondition = raw.if === undefined ? undefined : readPrecondition(raw.if, { operationIndex, field: "if" });
      if (precondition && !precondition.ok) return precondition;
      return { ok: true, value: { op: "delete", targets, ...(precondition ? { if: precondition.value } : {}) } };
    }
    default:
      return decodeFail("malformed-request", `未知 operation ${String(op)}`, { operationIndex, field: "op" });
  }
}

function readPlacement(raw: unknown, location: AgentDecodeLocation): AgentDecodeResult<AgentCreatePlacement> {
  if (raw === undefined) return { ok: true, value: { mode: "auto" } };
  if (!isJsonObject(raw)) return decodeFail("malformed-request", "placement 必须是对象", location);
  const mode = raw.mode;
  if (mode === "absolute") {
    if (!isJsonObject(raw.position)) {
      return decodeFail("malformed-request", "absolute placement 需要 position", { ...location, field: "placement.position" });
    }
    const position = readPosition(raw.position, { ...location, field: "placement.position" });
    if (!position.ok) return position;
    return { ok: true, value: { mode: "absolute", position: position.value } };
  }
  if (mode === "auto") return { ok: true, value: { mode: "auto" } };
  if (mode === "after" || mode === "before" || mode === "below") {
    const anchor = readEntityRef(raw.anchor, { ...location, field: "placement.anchor" });
    if (!anchor.ok) return anchor;
    const gap = raw.gap;
    if (gap !== undefined && (!isFiniteNumber(gap) || gap < 0)) {
      return decodeFail("malformed-request", "placement.gap 必须是非负有限数值", { ...location, field: "placement.gap" });
    }
    return { ok: true, value: { mode, anchor: anchor.value, ...(gap !== undefined ? { gap } : {}) } };
  }
  return decodeFail("malformed-request", `未知 placement.mode ${String(mode)}`, { ...location, field: "placement.mode" });
}

function readPrecondition(raw: unknown, location: AgentDecodeLocation): AgentDecodeResult<AgentPrecondition> {
  if (!isJsonObject(raw)) return decodeFail("malformed-request", "if 必须是对象", location);
  const type = raw.type;
  if (type === "node-exists" || type === "node-missing" || type === "not-processing") {
    if (!isBoundedId(raw.nodeId)) return decodeFail("malformed-request", "if.nodeId 必须是非空字符串", { ...location, field: "if.nodeId" });
    return { ok: true, value: { type, nodeId: raw.nodeId } };
  }
  if (type === "prompt-equals") {
    if (!isBoundedId(raw.nodeId)) return decodeFail("malformed-request", "if.nodeId 必须是非空字符串", { ...location, field: "if.nodeId" });
    if (typeof raw.equals !== "string") return decodeFail("malformed-request", "if.equals 必须是字符串", { ...location, field: "if.equals" });
    return { ok: true, value: { type, nodeId: raw.nodeId, equals: raw.equals } };
  }
  return decodeFail("malformed-request", `未知 if.type ${String(type)}`, { ...location, field: "if.type" });
}
