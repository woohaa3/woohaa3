/** Shared ordered compiler. Geometry is derived from the latest authority snapshot. */
import { effectiveCanvasNodeSize } from "../../node-dimensions.js";
import {
  AGENT_CANVAS_LIMITS,
  type AgentCanvasError,
  type AgentEntityRef,
  type AgentNormalizedOperation,
  type AgentPrecondition,
} from "../../agent-canvas-protocol.js";
import {
  defaultAgentNodeData,
  findAgentNodeDescriptor,
  agentDescriptorForCanonicalType,
} from "../../agent-node-descriptors.js";
import type { CanvasCommand } from "../../commands.js";
import type { CanvasNodeData } from "../../domain/index.js";
import { deriveEntityId, hashText, hashPlanPayload } from "./hash.js";
import { defaultConnectLabel, indexSnapshot, resolvePlacement, type PlacementState } from "./placement.js";
import { PlanGeometry, PlanGeometryError, planAssert } from "./geometry.js";
import { projectCanvasOrganization } from "../organization.js";
import type { CompiledEntityRef, DeclaredEntity, PlanCompileInput, PlanCompileResult } from "./types.js";

export function compileAgentPlan(input: PlanCompileInput): PlanCompileResult {
  const geometry = new PlanGeometry(input.snapshot);
  const declaredRefs = new Map<string, DeclaredEntity>();
  const refs: Record<string, string> = {},
    entities: CompiledEntityRef[] = [],
    commands: CanvasCommand[] = [],
    preconditions: AgentPrecondition[] = [],
    warnings: string[] = [],
    normalized: AgentNormalizedOperation[] = [];
  const readReferences = new Set<string>();
  const principal = input.principalId ?? "";
  const identity = principal === "" ? [input.canvasId, input.requestId] : [principal, input.canvasId, input.requestId];
  const commandId = `agent-plan:${hashText((principal === "" ? [input.canvasId, input.scope, input.requestId] : [principal, input.canvasId, input.scope, input.requestId]).join("\u0000"))}`;
  let edges = input.snapshot.edges.map((e) => ({ ...e }));
  let operationIndex = 0;
  const resolve = (ref: AgentEntityRef, field = "target"): string => {
    if ("ref" in ref) {
      const entity = declaredRefs.get(ref.ref);
      planAssert(entity, "unknown-ref", `未知或前向 ref ${ref.ref}`, field);
      planAssert(entity.kind === "node", "invalid-ref", `ref ${ref.ref} 不是节点`, field);
      planAssert(geometry.nodes.has(entity.nodeId), "unknown-ref", `ref ${ref.ref} 已删除`, field);
      return entity.nodeId;
    }
    geometry.require(ref.nodeId);
    return ref.nodeId;
  };
  const declare = (ref: string, id: string, type: string, edge = false) => {
    planAssert(!declaredRefs.has(ref), "duplicate-ref", `ref ${ref} 重复`, "ref");
    planAssert(
      !geometry.originalIds.has(id) && !input.snapshot.edges.some((e) => e.id === id),
      "entity-id-collision",
      `实体 ${id} 已存在`,
      "ref",
    );
    declaredRefs.set(
      ref,
      edge ? { kind: "edge", canonicalType: "edge", edgeId: id } : { kind: "node", canonicalType: type, nodeId: id },
    );
    refs[ref] = id;
    entities.push({
      ref,
      kind: edge ? null : (agentDescriptorForCanonicalType(type)?.kind ?? null),
      canonicalType: type,
      ...(edge ? { edgeId: id } : { nodeId: id }),
    });
  };
  const place = (
    placement: import("../../agent-canvas-protocol.js").AgentCreatePlacement | undefined,
    size: { width: number; height: number },
    groupId?: string,
  ) => {
    const root = input.snapshot.rootGroupId ? geometry.require(input.snapshot.rootGroupId) : undefined;
    if (root && !groupId && (!placement || placement.mode === "auto")) {
      const children = geometry.children(root.id);
      return { x: children.length ? Math.max(...children.map(n => n.position.x + n.width)) + AGENT_CANVAS_LIMITS.layoutGap : root.position.x + 40, y: root.position.y + 40 };
    }
    if (root && !groupId && placement?.mode === "absolute") return { x: root.position.x + placement.position.x, y: root.position.y + placement.position.y };
    if (groupId && placement && placement.mode !== "auto") {
      if (placement.mode === "absolute") return { ...placement.position };
      const anchorId = resolve(placement.anchor);
      planAssert(
        anchorId !== groupId && !geometry.isAncestor(groupId, anchorId) && !geometry.isAncestor(anchorId, groupId),
        "unsupported-placement",
        "组不能相对自身、祖先或后代定位",
        "placement.anchor",
      );
      const anchor = geometry.require(anchorId),
        a = { ...anchor, ...effectiveCanvasNodeSize(anchor) },
        gap = placement.gap ?? AGENT_CANVAS_LIMITS.layoutGap;
      return placement.mode === "before"
        ? { x: a.position.x - size.width - gap, y: a.position.y }
        : placement.mode === "after"
          ? { x: a.position.x + a.width + gap, y: a.position.y }
          : { x: a.position.x, y: a.position.y + a.height + gap };
    }
    if (placement && "anchor" in placement) resolve(placement.anchor);
    const nodes = [...geometry.nodes.values()]
      .filter((n) => n.id !== groupId)
      .map((n) => ({ ...n, parentId: undefined }));
    const state: PlacementState = {
      snapshot: indexSnapshot({ ...input.snapshot, nodes, edges }),
      declaredRefs,
      plannedNodes: new Map(
        [...declaredRefs].flatMap(([ref, e]) => {
          const n = e.kind === "node" ? geometry.nodes.get(e.nodeId) : undefined;
          return n
            ? [[ref, { ref, canonicalType: n.type, position: n.position, ...effectiveCanvasNodeSize(n) }]]
            : [];
        }),
      ),
      deletedRefs: new Set(
        [...declaredRefs].filter(([, e]) => e.kind === "node" && !geometry.nodes.has(e.nodeId)).map(([ref]) => ref),
      ),
      plannedRects: [],
      operationIndex,
    };
    const result = resolvePlacement(placement, { defaultSize: size }, state);
    if (!result.ok) throw new PlanGeometryError(result.error.code, result.error.message, result.error.field);
    return result.position;
  };
  try {
    // change: 2026-10-22-remove-agent-execution-limits，任务 5.1：删除计划操作数、派生命令数、
    // 影响实体数、prompt/源码字节等应用侧总量门禁；完整计划经同一 planner 校验后一次原子提交。
    planAssert(input.operations.length > 0, "malformed-request", "计划需要至少一个操作");
    for (const operation of input.operations) {
      const before = geometry.canonical();
      switch (operation.op) {
        case "create_node": {
          const descriptor = findAgentNodeDescriptor(operation.kind);
          planAssert(descriptor, "unsupported-node-kind", `不支持的节点种类 ${operation.kind}`, "kind");
          if (operation.title !== undefined)
            planAssert(
              operation.title.length <= AGENT_CANVAS_LIMITS.titleMaxChars,
              "limit-exceeded",
              "title 超过 200 字符",
              "title",
            );
          const id = deriveEntityId(descriptor.canonicalType, [...identity, operation.ref, "node"]);
          declare(operation.ref, id, descriptor.canonicalType);
          const position = place(operation.placement, descriptor.defaultSize);
          geometry.nodes.set(id, {
            id,
            type: descriptor.canonicalType,
            position,
            ...descriptor.defaultSize,
            title: operation.title,
            parentId: input.snapshot.rootGroupId,
          });
          geometry.touch(id);
          commands.push({
            type: "node.add",
            node: { id, type: descriptor.canonicalType, position: input.snapshot.rootGroupId ? { x: position.x - geometry.require(input.snapshot.rootGroupId).position.x, y: position.y - geometry.require(input.snapshot.rootGroupId).position.y } : position, parentId: input.snapshot.rootGroupId, ...descriptor.defaultSize },
            nodeData: {
              ...defaultAgentNodeData(operation.kind),
              ...(operation.title !== undefined ? { title: operation.title } : {}),
              ...(operation.prompt !== undefined ? { prompt: operation.prompt } : {}),
            } as CanvasNodeData,
          });
          if (input.snapshot.rootGroupId) geometry.refit([input.snapshot.rootGroupId]);
          normalized.push({ ...operation, resolvedId: id });
          break;
        }
        case "create_group": {
          const members = operation.members.map((r) => resolve(r, "members")),
            selected = geometry.roots(members, true);
          planAssert(
            operation.title.trim() && operation.title.length <= AGENT_CANVAS_LIMITS.titleMaxChars,
            "malformed-request",
            "group 需要 1..200 字符标题",
            "title",
          );
          const id = deriveEntityId("group", [...identity, operation.ref, "node"]);
          declare(operation.ref, id, "group");
          const parentId = selected[0].parentId;
          geometry.nodes.set(id, {
            id,
            type: "group",
            parentId,
            position: { ...selected[0].position },
            width: 248,
            height: 232,
            title: operation.title,
          });
          geometry.touch(id);
          for (const n of selected) {
            geometry.touch(n.id);
            n.parentId = id;
          }
          geometry.refit([id]);
          if (operation.layout) geometry.grid(members, operation.layout);
          const group = geometry.require(id);
          if (operation.placement) {
            geometry.move(id, place(operation.placement, effectiveCanvasNodeSize(group), id));
            geometry.refit([parentId]);
          }
          const final = geometry.canonical().find((n) => n.id === id)!;
          commands.push({
            type: "node.add",
            node: {
              id,
              type: "group",
              parentId: final.parentId,
              position: final.position,
              width: final.width,
              height: final.height,
            },
            nodeData: { title: operation.title },
          });
          normalized.push({ ...operation, resolvedId: id });
          break;
        }
        case "connect": {
          const from = resolve(operation.from, "from"),
            to = resolve(operation.to, "to");
          if (geometry.originalIds.has(from)) readReferences.add(from);
          if (geometry.originalIds.has(to)) readReferences.add(to);
          planAssert(
            from !== to && geometry.require(from).type !== "group" && geometry.require(to).type !== "group",
            "invalid-connection",
            "不能连接自身或 group",
          );
          planAssert(!edges.some((e) => e.source === from && e.target === to), "duplicate-edge", "连线已存在");
          const id = deriveEntityId("edge", [...identity, operation.ref, "edge"]);
          declare(operation.ref, id, "edge", true);
          edges.push({ id, source: from, target: to });
          commands.push({ type: "edge.add", edge: { id, source: from, target: to } });
          const label = operation.label ?? defaultConnectLabel(geometry.require(from).type, geometry.require(to).type);
          if (label) warnings.push(`connect ${operation.ref} 使用标签「${label}」`);
          normalized.push({ ...operation, resolvedId: id });
          break;
        }
        case "set_prompt": {
          const id = resolve(operation.target);
          planAssert(
            findAgentNodeDescriptor(agentDescriptorForCanonicalType(geometry.require(id).type)?.kind ?? "")
              ?.supportsPrompt,
            "unsupported-node-kind",
            "该节点不支持 prompt",
          );
          geometry.touch(id);
          commands.push({ type: "nodeData.patch", nodeId: id, value: { prompt: operation.prompt } });
          normalized.push(operation);
          break;
        }
        case "set_title": {
          planAssert(
            operation.title.trim() && operation.title.length <= AGENT_CANVAS_LIMITS.titleMaxChars,
            "malformed-request",
            "title 需要 1..200 字符",
            "title",
          );
          const id = resolve(operation.target);
          geometry.require(id).title = operation.title;
          geometry.touch(id);
          commands.push({ type: "nodeData.patch", nodeId: id, value: { title: operation.title } });
          normalized.push(operation);
          break;
        }
        case "move_node": {
          const id = resolve(operation.target),
            node = geometry.require(id),
            parent = node.parentId ? geometry.require(node.parentId) : undefined;
          const position =
            operation.coordinateSpace === "world"
              ? operation.position
              : {
                  x: operation.position.x + (parent?.position.x ?? 0),
                  y: operation.position.y + (parent?.position.y ?? 0),
                };
          geometry.move(id, position);
          geometry.refit([node.parentId]);
          normalized.push(operation);
          break;
        }
        case "reparent":
          geometry.reparent(
            operation.targets.map((r) => resolve(r, "targets")),
            operation.parent === null ? null : resolve(operation.parent),
          );
          normalized.push(operation);
          break;
        case "ungroup":
          geometry.ungroup(resolve(operation.target));
          normalized.push(operation);
          break;
        case "layout":
          geometry.grid(
            operation.targets.map((r) => resolve(r, "targets")),
            operation.layout,
          );
          normalized.push(operation);
          break;
        case "delete": {
          const removed = geometry.remove(operation.targets.map((r) => resolve(r, "targets")));
          for (const edge of edges)
            if (removed.has(edge.source) || removed.has(edge.target)) {
              if (geometry.originalIds.has(edge.source)) readReferences.add(edge.source);
              if (geometry.originalIds.has(edge.target)) readReferences.add(edge.target);
            }
          edges = edges.filter((e) => !removed.has(e.source) && !removed.has(e.target));
          normalized.push(operation);
          break;
        }
      }
      if ("if" in operation && operation.if) preconditions.push(operation.if);
      commands.push(...geometry.diff(before));
      operationIndex++;
    }
    const finalNodes = geometry.canonical();
    const predicted: Record<string, { x: number; y: number }> = {};
    for (const [ref, e] of declaredRefs)
      if (e.kind === "node" && geometry.nodes.has(e.nodeId))
        predicted[ref] = { ...geometry.require(e.nodeId).position };
    for (const id of geometry.affected)
      if (geometry.originalIds.has(id) && geometry.nodes.has(id)) predicted[id] = { ...geometry.require(id).position };
    return {
      ok: true,
      commands,
      preconditions,
      refs,
      entities,
      normalized,
      warnings,
      basisRevision: input.snapshot.revision,
      commandId,
      payloadHash: "",
      predicted,
      finalNodes,
      organization: projectCanvasOrganization(finalNodes, [...geometry.affected], edges),
      touchedExistingNodeIds: [
        ...new Set([...readReferences, ...[...geometry.affected].filter((id) => geometry.originalIds.has(id))]),
      ],
    };
  } catch (error) {
    if (!(error instanceof PlanGeometryError)) throw error;
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        retryable: false,
        operationIndex,
        ...(error.field ? { field: error.field } : {}),
      } satisfies AgentCanvasError,
    };
  }
}

export async function compileAgentPlanWithHash(input: PlanCompileInput): Promise<PlanCompileResult> {
  const compiled = compileAgentPlan(input);
  if (!compiled.ok) return compiled;
  return {
    ...compiled,
    payloadHash: await hashPlanPayload({ canvasId: input.canvasId, operations: input.operations }),
  };
}
export type { CompiledEntityRef, PlanCompileInput, PlanCompileResult, PlanScope, PlannerSnapshot } from "./types.js";
export { deriveEntityId, hashText, hashPlanPayload, sha256Hex, stableStringify } from "./hash.js";
export type { PlannedNode } from "./placement.js";
export {
  defaultConnectLabel,
  hasEdge,
  indexSnapshot,
  rectOf,
  resolveAnchorGeometry,
  resolvePlacement,
  sizeOf,
  type IndexedSnapshot,
  type PlacementState,
  type Rect,
} from "./placement.js";
