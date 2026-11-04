/**
 * Canvas script：首次回执摘要纯函数
 * （change: 2026-10-13-add-canvas-script-authoring，任务 3.7）。
 *
 * 自 `service.ts` 拆出：受影响节点/边摘要、实际删除 ID 与冻结回执构造。
 * 全部从**计划与实际命令**推导并冻结，**不含源码**。
 */
import type {
  ServerCanvas,
  CanvasCommand,
  CanvasNodeData,
  CanvasScriptSubmissionMeta,
  CanvasScriptSubmitReceipt
} from "@woohaa3/contracts";
import {
  agentDescriptorForCanonicalType,
  effectiveCanvasNodeSize,
  collectWoohaa3CanvasRemovalIds,
  projectNodeAffordances,
  CANVAS_SCRIPT_PROTOCOL_VERSION
} from "@woohaa3/contracts";

/**
 * 首次受影响节点摘要（不含源码）。
 *
 * 摘要来自**计划与实际命令**：新建节点取命令携带的 canonical type/geometry 与计划默认
 * nodeData；既有节点取当前权威快照。kind/affordances 经 contracts 描述符投影，不伪造。
 */
export function summarizeNodes(
  canvas: ServerCanvas,
  commands: readonly CanvasCommand[]
): CanvasScriptSubmissionMeta["nodes"] {
  const touched = new Set<string>();
  for (const command of commands) {
    switch (command.type) {
      case "node.add": touched.add(command.node.id); break;
      case "node.update":
      case "nodeData.patch": touched.add(command.nodeId); break;
      case "node.remove": for (const id of command.nodeIds) touched.add(id); break;
      default: break;
    }
  }
  const createdById = new Map<string, Extract<CanvasCommand, { type: "node.add" }>>();
  const patchedById = new Map<string, Extract<CanvasCommand, { type: "nodeData.patch" }>>();
  for (const command of commands) {
    if (command.type === "node.add") createdById.set(command.node.id, command);
    if (command.type === "nodeData.patch") patchedById.set(command.nodeId, command);
  }
  return [...touched].map((nodeId) => {
    const node = canvas.document.nodes.find((entry) => entry.id === nodeId);
    const created = createdById.get(nodeId);
    const canonicalType = node?.type ?? created?.node.type ?? "unknown";
    const baseData = (node ? canvas.nodeData[nodeId] : created?.nodeData) as CanvasNodeData | undefined;
    const patch = patchedById.get(nodeId)?.value as CanvasNodeData | undefined;
    const data = patch ? { ...(baseData ?? {}), ...patch } : baseData;
    const descriptor = agentDescriptorForCanonicalType(canonicalType, data);
    const size = effectiveCanvasNodeSize({
      type: canonicalType,
      width: node?.width ?? created?.node.width,
      height: node?.height ?? created?.node.height
    });
    return {
      nodeId,
      canonicalType,
      kind: descriptor?.kind ?? null,
      ...(typeof data?.title === "string" && data.title !== "" ? { title: data.title } : {}),
      ...(typeof data?.prompt === "string" ? { prompt: data.prompt } : {}),
      position: { x: node?.position?.x ?? created?.node.position?.x ?? 0, y: node?.position?.y ?? created?.node.position?.y ?? 0 },
      size,
      affordances: projectNodeAffordances(canonicalType, data)
    };
  });
}

/** 首次受影响边摘要（冻结）。 */
export function summarizeEdges(canvas: ServerCanvas, commands: readonly CanvasCommand[]): CanvasScriptSubmissionMeta["edges"] {
  const pairs: Array<{ edgeId: string; source: string; target: string }> = [];
  for (const command of commands) {
    if (command.type === "edge.add") {
      const existing = canvas.document.edges.find((edge) => edge.source === command.edge.source && edge.target === command.edge.target);
      const edgeId = command.edge.id ?? existing?.id;
      if (edgeId) pairs.push({ edgeId, source: command.edge.source, target: command.edge.target });
    }
    if (command.type === "edge.remove") {
      const existing = canvas.document.edges.find((edge) => edge.id === command.edgeId);
      if (existing) pairs.push({ edgeId: existing.id, source: existing.source, target: existing.target });
    }
  }
  return pairs;
}

/**
 * 首次实际删除的节点 ID（含领域级联的 group 后代与空父容器），与 reducer 同一实现。
 *
 * spec「回执包含实际删除的节点和边 ID」：显式命令目标与领域级联后代都要报告。
 */
export function collectDeletedNodeIds(canvas: ServerCanvas, commands: readonly CanvasCommand[]): string[] {
  const ids = new Set<string>();
  for (const command of commands) {
    if (command.type !== "node.remove") continue;
    for (const id of collectWoohaa3CanvasRemovalIds(canvas.document.nodes, command.nodeIds, canvas.nodeData)) ids.add(id);
  }
  return [...ids];
}

/** 首次实际删除的边 ID：显式 edge.remove 与因端点删除而被移除的关联边。 */
export function collectDeletedEdgeIds(canvas: ServerCanvas, commands: readonly CanvasCommand[]): string[] {
  const removedNodes = new Set(collectDeletedNodeIds(canvas, commands));
  const ids = new Set<string>();
  for (const command of commands) if (command.type === "edge.remove") ids.add(command.edgeId);
  for (const edge of canvas.document.edges) {
    if (removedNodes.has(edge.source) || removedNodes.has(edge.target)) ids.add(edge.id);
  }
  return [...ids];
}

/** 冻结首次回执（从持久化元数据重建，不从当前画布拼装）。 */
export function frozenReceipt(
  script: CanvasScriptSubmissionMeta,
  request: { canvasId: string; requestId: string },
  revision: number,
  duplicate: boolean,
  noop: boolean
): CanvasScriptSubmitReceipt {
  return {
    ok: true,
    protocolVersion: CANVAS_SCRIPT_PROTOCOL_VERSION,
    version: script.version,
    canvasId: request.canvasId,
    requestId: request.requestId,
    submissionHash: script.submissionHash,
    revision,
    duplicate,
    noop,
    refs: script.refs,
    nodes: script.nodes,
    edges: script.edges,
    deletedNodeIds: script.deletedNodeIds,
    deletedEdgeIds: script.deletedEdgeIds,
    ...(script.organization ? { organization: script.organization } : {})
  };
}
