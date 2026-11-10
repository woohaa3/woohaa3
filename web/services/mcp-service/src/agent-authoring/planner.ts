/**
 * 统一 Agent Plan 编译器（change: add-agent-canvas-authoring-mcp，任务 4.1–4.6 / design D2、D3、D8、D9；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R28 —— 抽出类型、
 *  稳定 hash/token 与几何 placement，本文件保留统一原子规划 `compileAgentPlan`）。
 *
 * MCP Service 的**唯一**语义写入路径：把类型化 plan 编译为一个既有 `CanvasCommand[]`，
 * 并派生确定性实体 ID、稳定 command identity、规范化 payload hash 与局部前置条件。
 *
 * 纯函数：不访问画布权威、不产生副作用（除了读取传入的 snapshot）。简单写工具
 * （create/connect/set_prompt/delete）与 `apply_canvas_plan` 共用本编译器，因此命令与回执语义一致。
 */
import {
  compileAgentPlan as compileScopedPlan,
  defaultAgentNodeData,
  findAgentNodeDescriptor,
  type AgentCanvasError,
  type AgentEntityRef,
  type AgentNormalizedOperation,
  type AgentPrecondition,
  type CanvasCommand,
  type CanvasNodeData
} from "@woohaa3/contracts";
import { deriveEntityId, hashPlanPayload, hashText } from "./planner-hash.js";
import {
  defaultConnectLabel,
  hasEdge,
  indexSnapshot,
  rectOf,
  resolvePlacement,
  type IndexedSnapshot,
  type Rect
} from "./planner-placement.js";
import type {
  CompiledEntityRef,
  DeclaredEntity,
  PlanCompileInput,
  PlanCompileResult
} from "./planner-types.js";

export type {
  PlanCompileInput,
  PlanCompileResult,
  PlanScope,
  PlannerSnapshot,
  CompiledEntityRef
} from "./planner-types.js";
export {
  AGENT_CAPABILITY_VERSION,
  createValidationToken,
  deriveEntityId,
  hashPlanPayload,
  hashText,
  readValidationToken,
  type ValidationTokenPayload
} from "./planner-hash.js";

/**
 * 编译 plan。
 *
 * 校验顺序（副作用前）：ref 符号表（未知/前向/重复）→ 快照中的节点/连接引用 → placement
 * → prompt/kind capability → 前置条件抽取。任一失败返回带 operationIndex/field 的错误。
 */
export function compileAgentPlan(input: PlanCompileInput): PlanCompileResult {
  if (input.snapshot.rootGroupId) return compileScopedPlan(input);
  const snapshot = indexSnapshot(input.snapshot);
  const declaredRefs = new Map<string, DeclaredEntity>();
  const refToId: Record<string, string> = {};
  const entities: CompiledEntityRef[] = [];
  const commands: CanvasCommand[] = [];
  const preconditions: AgentPrecondition[] = [];
  const warnings: string[] = [];
  const normalized: AgentNormalizedOperation[] = [];
  /** 计划内新建/移动后的节点矩形，供布局避让。 */
  const plannedRects: Rect[] = [];

  const identity = [input.canvasId, input.scope, input.requestId];
  // 实体 ID 只由 canvas + requestId + ref + kind 派生（不含 scope），因此简单工具与等价
  // `apply_canvas_plan` 生成同一实体（任务 5.3）。command identity 额外含 scope，避免不同工具
  // 复用同一 requestId 冲突（design D3）。
  const entityIdentity = [input.canvasId, input.requestId];
  const commandId = `agent-plan:${hashText(identity.join("\u0000"))}`;

  for (const [operationIndex, operation] of input.operations.entries()) {
    switch (operation.op) {
      case "create_node": {
        if (declaredRefs.has(operation.ref)) {
          return fail(operationIndex, "ref", "duplicate-ref", `ref ${operation.ref} 重复声明`);
        }
        const descriptor = findAgentNodeDescriptor(operation.kind);
        if (!descriptor) {
          return fail(operationIndex, "kind", "unsupported-node-kind", `不支持的节点种类 ${operation.kind}`);
        }
        const nodeId = deriveEntityId(`${descriptor.canonicalType}`, [...entityIdentity, operation.ref, "node"]);
        const worldModel = descriptor.canonicalType === "model3d";
        const placement = resolvePlacement(operation.placement, {
          descriptor: worldModel ? { ...descriptor, worldOnly: true } : descriptor,
          snapshot,
          declaredRefs,
          plannedRects,
          operationIndex
        });
        if (!placement.ok) return placement;
        const world = worldModel
          ? { instanceId: deriveEntityId("world-instance", [...entityIdentity, operation.ref, "instance"]), point: placement.position }
          : undefined;
        const nodeData = {
          ...(defaultAgentNodeData(operation.kind, world) ?? {}),
          ...(operation.title !== undefined ? { title: operation.title } : {}),
          ...(operation.prompt !== undefined ? { prompt: operation.prompt } : {})
        } as CanvasNodeData;
        commands.push({
          type: "node.add",
          node: {
            id: nodeId,
            type: descriptor.canonicalType,
            position: placement.position,
            width: descriptor.defaultSize.width,
            height: descriptor.defaultSize.height
          },
          nodeData
        });
        // 模型没有卡片矩形，不参与后续卡片的避让与布局。
        if (!worldModel) plannedRects.push(rectOf(placement.position, descriptor.defaultSize));
        declaredRefs.set(operation.ref, { kind: "node", canonicalType: descriptor.canonicalType, nodeId });
        refToId[operation.ref] = nodeId;
        entities.push({ ref: operation.ref, kind: descriptor.kind, canonicalType: descriptor.canonicalType, nodeId });
        normalized.push({ ...operation, resolvedId: nodeId });
        break;
      }
      case "connect": {
        if (declaredRefs.has(operation.ref) && declaredRefs.get(operation.ref)!.kind !== "edge") {
          return fail(operationIndex, "ref", "duplicate-ref", `ref ${operation.ref} 已被节点占用`);
        }
        const from = resolveEntityRef(operation.from, declaredRefs, snapshot, operationIndex, "from");
        if (!from.ok) return from;
        const to = resolveEntityRef(operation.to, declaredRefs, snapshot, operationIndex, "to");
        if (!to.ok) return to;
        if (from.nodeId === to.nodeId) {
          return fail(operationIndex, "to", "invalid-connection", "不能连接节点到自身");
        }
        const sourceNode = snapshot.nodeById.get(from.nodeId);
        const targetNode = snapshot.nodeById.get(to.nodeId);
        if (hasEdge(snapshot, from.nodeId, to.nodeId)) {
          return fail(operationIndex, "to", "duplicate-edge", `${from.nodeId} -> ${to.nodeId} 已存在连线`);
        }
        const edgeId = deriveEntityId("edge", [...entityIdentity, operation.ref, "edge"]);
        const label = operation.label ?? defaultConnectLabel(sourceNode?.type ?? "", targetNode?.type ?? "");
        commands.push({
          type: "edge.add",
          edge: { id: edgeId, source: from.nodeId, target: to.nodeId }
        });
        if (label) warnings.push(`connect ${operation.ref} 使用标签「${label}」`);
        collectPrecondition(operation.if, operationIndex, preconditions);
        declaredRefs.set(operation.ref, { kind: "edge", canonicalType: "edge", edgeId });
        refToId[operation.ref] = edgeId;
        entities.push({ ref: operation.ref, kind: null, canonicalType: "edge", edgeId });
        normalized.push({ ...operation, resolvedId: edgeId });
        break;
      }
      case "set_prompt": {
        const target = resolveEntityRef(operation.target, declaredRefs, snapshot, operationIndex, "target");
        if (!target.ok) return target;
        commands.push({ type: "nodeData.patch", nodeId: target.nodeId, value: { prompt: operation.prompt } });
        collectPrecondition(operation.if, operationIndex, preconditions);
        normalized.push(operation);
        break;
      }
      case "move_node": {
        const target = resolveEntityRef(operation.target, declaredRefs, snapshot, operationIndex, "target");
        if (!target.ok) return target;
        commands.push({ type: "node.update", nodeId: target.nodeId, position: { ...operation.position } });
        collectPrecondition(operation.if, operationIndex, preconditions);
        normalized.push(operation);
        break;
      }
      case "delete": {
        const nodeIds: string[] = [];
        for (const [targetIndex, ref] of operation.targets.entries()) {
          const target = resolveEntityRef(ref, declaredRefs, snapshot, operationIndex, `targets[${targetIndex}]`);
          if (!target.ok) return target;
          nodeIds.push(target.nodeId);
        }
        commands.push({ type: "node.remove", nodeIds });
        collectPrecondition(operation.if, operationIndex, preconditions);
        normalized.push(operation);
        break;
      }
    }
  }

  if (commands.length === 0) {
    return { ok: false, error: { code: "malformed-request", message: "计划为空", retryable: false } };
  }

  return {
    ok: true,
    commands,
    preconditions,
    refs: refToId,
    entities,
    normalized,
    warnings,
    basisRevision: input.snapshot.revision,
    commandId,
    payloadHash: "" // 由 async compileAgentPlanWithHash 填充
  };
}

function resolveEntityRef(
  ref: AgentEntityRef,
  declaredRefs: Map<string, DeclaredEntity>,
  snapshot: IndexedSnapshot,
  operationIndex: number,
  field: string
): { ok: true; nodeId: string } | { ok: false; error: AgentCanvasError } {
  if ("ref" in ref) {
    const declared = declaredRefs.get(ref.ref);
    if (!declared) {
      return { ok: false, error: { code: "unknown-ref", message: `引用了未声明或前向 ref ${ref.ref}`, retryable: false, operationIndex, field } };
    }
    if (declared.kind !== "node") {
      return { ok: false, error: { code: "invalid-ref", message: `ref ${ref.ref} 不是节点`, retryable: false, operationIndex, field } };
    }
    return { ok: true, nodeId: declared.nodeId };
  }
  if (!snapshot.nodeById.has(ref.nodeId)) {
    return { ok: false, error: { code: "unknown-node", message: `节点 ${ref.nodeId} 不存在`, retryable: false, operationIndex, field } };
  }
  return { ok: true, nodeId: ref.nodeId };
}

function collectPrecondition(
  condition: AgentPrecondition | undefined,
  operationIndex: number,
  sink: AgentPrecondition[]
): void {
  if (!condition) return;
  void operationIndex;
  sink.push(condition);
}

function fail(
  operationIndex: number,
  field: string,
  code: string,
  message: string
): { ok: false; error: AgentCanvasError } {
  return { ok: false, error: { code, message, retryable: false, operationIndex, field } };
}

/** 异步编译：在同步编译成功后补齐 payloadHash。 */
export async function compileAgentPlanWithHash(input: PlanCompileInput): Promise<PlanCompileResult> {
  const compiled = compileAgentPlan(input);
  if (!compiled.ok) return compiled;
  const payloadHash = await hashPlanPayload({
    canvasId: input.canvasId,
    operations: input.operations
  });
  return { ...compiled, payloadHash };
}
