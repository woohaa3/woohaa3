/**
 * Canvas Agent authoring application service
 * （change: add-agent-canvas-authoring-mcp，任务 2.3 / 3.5 / 4.7 / design D7–D9）。
 *
 * MCP Service 提交的已编译计划在这里落到权威 room：
 * - 局部前置条件在**权威 snapshot 上、命令批次提交前**复核，任一失败整批拒绝（design D9）；
 * - 复用 `CanvasRoom.submit` 的 durable command receipt（commandId + payloadHash 幂等）；
 * - 成功后返回 canonical 实体摘要与 revision，MCP 无需从本地计划猜测结果。
 *
 * 它只依赖 `resolveRoom` 与 `listCanvases` 两个注入端口，不 import MCP 实现，也不缓存权威。
 */
import type { CanvasRoom } from "../sync/index.js";
import type { CanvasCommand, CanvasNodeData, ServerCanvas } from "@woohaa3/contracts";
import {
  agentDescriptorForCanonicalType,
  projectNodeAffordances,
  type AgentPrecondition
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION, computeCommandPayloadHash, type CanvasCommandBatch } from "@woohaa3/contracts/canvas-yjs";
import type {
  AgentApplyEntity,
  AgentApplyEdge
} from "@woohaa3/contracts";

export type AgentAuthoringDependencies = {
  resolveRoom: (canvasId: string) => Promise<CanvasRoom | null>;
  now?: () => string;
};

export type AgentApplyInput = {
  canvasId: string;
  requestId: string;
  commandId: string;
  payloadHash: string;
  baseRevision: number;
  commands: CanvasCommand[];
  preconditions?: AgentPrecondition[];
};

export type AgentApplyOutcome =
  | {
      ok: true;
      canvasId: string;
      requestId: string;
      revision: number;
      duplicate: boolean;
      noop: boolean;
      nodes: AgentApplyEntity[];
      edges: AgentApplyEdge[];
    }
  | {
      ok: false;
      code: string;
      message: string;
      retryable?: boolean;
      currentRevision?: number;
      preconditionIndex?: number;
    };

/**
 * 复核局部前置条件（纯函数）。
 *
 * 返回失败的 precondition 索引与可读原因；全部通过返回 null。刻意不做全局 revision CAS：
 * 无关节点变化不阻止计划（design D9）。
 */
export function checkAgentPreconditions(
  canvas: ServerCanvas,
  preconditions: readonly AgentPrecondition[]
): { index: number; message: string } | null {
  for (const [index, condition] of preconditions.entries()) {
    const node = canvas.document.nodes.find((entry) => entry.id === condition.nodeId);
    const data = canvas.nodeData[condition.nodeId] as CanvasNodeData | undefined;
    switch (condition.type) {
      case "node-exists":
        if (!node) return { index, message: `前置条件失败：节点 ${condition.nodeId} 不存在` };
        break;
      case "node-missing":
        if (node) return { index, message: `前置条件失败：节点 ${condition.nodeId} 已存在` };
        break;
      case "prompt-equals": {
        const current = typeof data?.prompt === "string" ? data.prompt : "";
        if (current !== condition.equals) {
          return { index, message: `前置条件失败：节点 ${condition.nodeId} 的 prompt 已变化` };
        }
        break;
      }
      case "not-processing":
        if (data?.taskStatus === "processing") {
          return { index, message: `前置条件失败：节点 ${condition.nodeId} 正在执行` };
        }
        break;
    }
  }
  return null;
}

/** 从提交后的权威画布派生 canonical 实体摘要（只含 Agent 决策所需字段）。 */
export function summarizeAppliedEntities(
  canvas: ServerCanvas,
  commands: readonly CanvasCommand[]
): { nodes: AgentApplyEntity[]; edges: AgentApplyEdge[] } {
  const touchedNodeIds = new Set<string>();
  const touchedEdgeIds = new Set<string>();
  for (const command of commands) {
    switch (command.type) {
      case "node.add":
        touchedNodeIds.add(command.node.id);
        break;
      case "node.update":
      case "nodeData.patch":
        touchedNodeIds.add(command.nodeId);
        break;
      case "node.remove":
        for (const nodeId of command.nodeIds) touchedNodeIds.add(nodeId);
        break;
      case "edge.add":
        if (command.edge.id) touchedEdgeIds.add(command.edge.id);
        else touchedNodeIds.add(command.edge.target);
        break;
      case "edge.remove":
        touchedEdgeIds.add(command.edgeId);
        break;
    }
  }
  // edge.add 未显式带 id 时按 (source,target) 匹配本次新增边。
  const addedConnections = commands
    .filter((command): command is Extract<CanvasCommand, { type: "edge.add" }> => command.type === "edge.add")
    .map((command) => ({ source: command.edge.source, target: command.edge.target }));

  const nodes: AgentApplyEntity[] = [];
  for (const nodeId of touchedNodeIds) {
    const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
    if (!node) continue;
    const data = canvas.nodeData[nodeId] as CanvasNodeData | undefined;
    const descriptor = agentDescriptorForCanonicalType(node.type);
    nodes.push({
      nodeId,
      canonicalType: node.type,
      kind: descriptor?.kind ?? null,
      ...(typeof data?.title === "string" && data.title !== "" ? { title: data.title } : {}),
      ...(typeof data?.prompt === "string" ? { prompt: data.prompt } : {}),
      position: { x: node.position.x, y: node.position.y },
      size: {
        width: node.width ?? descriptor?.defaultSize.width ?? 196,
        height: node.height ?? descriptor?.defaultSize.height ?? 64
      },
      affordances: projectNodeAffordances(node.type, data)
    });
  }

  const edges: AgentApplyEdge[] = [];
  for (const edge of canvas.document.edges) {
    if (touchedEdgeIds.has(edge.id) || addedConnections.some((connection) => connection.source === edge.source && connection.target === edge.target)) {
      const label = edge.data?.label;
      edges.push({ edgeId: edge.id, source: edge.source, target: edge.target, ...(typeof label === "string" && label !== "" ? { label } : {}) });
    }
  }

  return { nodes, edges };
}

export class AgentCanvasAuthoringService {
  private readonly deps: AgentAuthoringDependencies;

  constructor(deps: AgentAuthoringDependencies) {
    this.deps = deps;
  }

  async apply(input: AgentApplyInput): Promise<AgentApplyOutcome> {
    const canvasId = input.canvasId?.trim() ?? "";
    if (canvasId === "") return { ok: false, code: "malformed-request", message: "canvasId 不能为空" };
    const room = await this.deps.resolveRoom(canvasId);
    if (!room) return { ok: false, code: "canvas-not-found", message: `画布 ${canvasId} 不存在` };

    const exported = room.exportCanvas();
    if (!exported.ok) return { ok: false, code: "canvas-unavailable", message: exported.message, retryable: true };
    const canvas = exported.canvas;

    // 幂等优先：相同 commandId 已登记时返回首次 durable receipt（不重复应用）。
    // 用与 room 一致的命令 payload hash 判定，而不是计划哈希——同一计划在重试时命令必须一致。
    const commandPayloadHash = await computeCommandPayloadHash({ canvasId, commands: input.commands });
    const existing = await room.lookupCommand(input.commandId);
    if (existing && existing.payloadHash === commandPayloadHash) {
      const summary = summarizeAppliedEntities(canvas, input.commands);
      return {
        ok: true,
        canvasId,
        requestId: input.requestId,
        revision: existing.revision,
        duplicate: true,
        noop: !existing.changed,
        ...summary
      };
    }
    if (existing && existing.payloadHash !== commandPayloadHash) {
      return { ok: false, code: "request-id-reused", message: "相同 requestId 使用了不同计划" };
    }

    // 局部前置条件在权威 snapshot 上于提交前复核（design D9）。
    if (input.preconditions && input.preconditions.length > 0) {
      const failure = checkAgentPreconditions(canvas, input.preconditions);
      if (failure) {
        return {
          ok: false,
          code: "precondition-failed",
          message: failure.message,
          currentRevision: canvas.revision,
          preconditionIndex: failure.index
        };
      }
    }

    const batch: CanvasCommandBatch = {
      protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
      canvasId,
      commandId: input.commandId,
      baseRevision: input.baseRevision,
      actorId: "mcp-service",
      commands: input.commands
    };
    const result = await room.submit(batch);
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        message: result.message,
        retryable: result.code === "storage-failed" || result.code === "storage-seq-conflict"
      };
    }

    // 从提交后的权威画布派生 canonical 摘要（noop/duplicate 时命令未再应用）。
    const latest = room.exportCanvas();
    const summary = latest.ok
      ? summarizeAppliedEntities(latest.canvas, input.commands)
      : { nodes: [], edges: [] };
    return {
      ok: true,
      canvasId,
      requestId: input.requestId,
      revision: result.revision,
      duplicate: result.status === "duplicate",
      noop: result.noop,
      ...summary
    };
  }
}
