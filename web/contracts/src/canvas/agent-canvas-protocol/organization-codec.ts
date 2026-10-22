/** Strict organization operation decoding, shared by scripts and the internal planner. */
import {
  AGENT_CANVAS_LIMITS,
  type AgentDecodeResult,
  type AgentEntityRef,
  type AgentGridLayout,
  type AgentPlanOperation,
} from "./types.js";
import { assertKnownKeys, decodeFail, readEntityRef, readPosition } from "./common-codec.js";
import { isBoundedId, isJsonObject } from "../../validation.js";

export function readGridLayout(raw: unknown, operationIndex: number): AgentDecodeResult<AgentGridLayout> {
  const loc = { operationIndex, field: "layout" };
  if (!isJsonObject(raw)) return decodeFail("malformed-request", "layout 必须是对象", loc);
  const known = assertKnownKeys(raw, ["mode", "columns", "gapX", "gapY", "origin"], loc);
  if (!known.ok) return known;
  if (
    raw.mode !== "grid" ||
    !Number.isInteger(raw.columns) ||
    Number(raw.columns) < 1 ||
    Number(raw.columns) > AGENT_CANVAS_LIMITS.maxGridColumns
  )
    return decodeFail("malformed-request", "layout 需要 mode=grid 和 1..256 整数 columns", loc);
  for (const key of ["gapX", "gapY"] as const)
    if (
      raw[key] !== undefined &&
      (typeof raw[key] !== "number" ||
        !Number.isFinite(raw[key]) ||
        raw[key] < 0 ||
        raw[key] > AGENT_CANVAS_LIMITS.maxPositionAbs)
    )
      return decodeFail("malformed-request", "layout gap 必须是有界非负有限数", loc);
  const origin = raw.origin === undefined ? undefined : readPosition(raw.origin, loc);
  if (origin && !origin.ok) return origin;
  return {
    ok: true,
    value: {
      mode: "grid",
      columns: Number(raw.columns),
      ...(raw.gapX !== undefined ? { gapX: raw.gapX as number } : {}),
      ...(raw.gapY !== undefined ? { gapY: raw.gapY as number } : {}),
      ...(origin?.ok ? { origin: origin.value } : {}),
    },
  };
}

export function readEntityRefs(
  raw: unknown,
  operationIndex: number,
  field: string,
): AgentDecodeResult<AgentEntityRef[]> {
  if (!Array.isArray(raw) || !raw.length || raw.length > AGENT_CANVAS_LIMITS.maxAffectedNodes)
    return decodeFail("malformed-request", `${field} 需要 1..256 个引用`, { operationIndex, field });
  const values: AgentEntityRef[] = [];
  for (const entry of raw) {
    const ref = readEntityRef(entry, { operationIndex, field });
    if (!ref.ok) return ref;
    values.push(ref.value);
  }
  return { ok: true, value: values };
}

export function readOrganizationOperation(
  raw: Record<string, unknown>,
  operationIndex: number,
): AgentDecodeResult<AgentPlanOperation> {
  const op = raw.op;
  const loc = { operationIndex };
  const fields =
    op === "create_group"
      ? ["op", "ref", "title", "members", "layout", "placement"]
      : op === "reparent"
        ? ["op", "targets", "parent"]
        : op === "layout"
          ? ["op", "targets", "layout"]
          : op === "set_title"
            ? ["op", "target", "title"]
            : ["op", "target"];
  const known = assertKnownKeys(raw, fields, loc);
  if (!known.ok) return known;
  if (op === "create_group" || op === "set_title") {
    if (typeof raw.title !== "string" || !raw.title.trim() || raw.title.length > AGENT_CANVAS_LIMITS.titleMaxChars)
      return decodeFail("malformed-request", "title 必须是 1..200 字符非空标题", { ...loc, field: "title" });
  }
  if (op === "create_group") {
    if (!isBoundedId(raw.ref)) return decodeFail("malformed-request", "group.ref 非法", loc);
    const members = readEntityRefs(raw.members, operationIndex, "members");
    if (!members.ok) return members;
    const layout = raw.layout === undefined ? undefined : readGridLayout(raw.layout, operationIndex);
    if (layout && !layout.ok) return layout;
    // placement is decoded by the common operation dispatcher.
    return {
      ok: true,
      value: {
        op,
        ref: raw.ref,
        title: raw.title as string,
        members: members.value,
        ...(layout?.ok ? { layout: layout.value } : {}),
      },
    };
  }
  if (op === "reparent" || op === "layout") {
    const targets = readEntityRefs(raw.targets, operationIndex, "targets");
    if (!targets.ok) return targets;
    if (op === "layout") {
      const layout = readGridLayout(raw.layout, operationIndex);
      return layout.ok ? { ok: true, value: { op, targets: targets.value, layout: layout.value } } : layout;
    }
    const parent =
      raw.parent === null ? { ok: true as const, value: null } : readEntityRef(raw.parent, { ...loc, field: "parent" });
    return parent.ok ? { ok: true, value: { op, targets: targets.value, parent: parent.value } } : parent;
  }
  const target = readEntityRef(raw.target, { ...loc, field: "target" });
  if (!target.ok) return target;
  return {
    ok: true,
    value:
      op === "set_title"
        ? { op, target: target.value, title: raw.title as string }
        : { op: "ungroup", target: target.value },
  };
}
