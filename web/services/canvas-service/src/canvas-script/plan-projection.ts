/**
 * Canvas script：计划投影与领域复核纯函数
 * （change: 2026-10-13-add-canvas-script-authoring，任务 3.5 / 3.6）。
 *
 * 自 `service.ts` 拆出：只读快照投影、局部前置条件复核、级联影响范围与阶段化错误映射。
 * 全部是纯函数，不持有状态、不写源码、不持久化。
 */
import type { ServerCanvas, CanvasCommand, AgentPrecondition, PlannerSnapshot } from "@woohaa3/contracts";
import {
  canvasScriptError,
  collectWoohaa3CanvasRemovalIds,
  type CanvasScriptError,
  type CanvasScriptErrorStage
} from "@woohaa3/contracts";

/** 只读计划快照投影（不含 nodeData/yjs）。 */
export function toPlannerSnapshot(canvas: ServerCanvas): PlannerSnapshot {
  return {
    canvasId: canvas.id,
    revision: canvas.revision,
    nodes: canvas.document.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      width: node.width,
      height: node.height,
      parentId: node.parentId,
      title: canvas.nodeData[node.id]?.title
    })),
    edges: canvas.document.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target }))
  };
}

/** 局部前置条件复核（权威 snapshot）。 */
export function checkPreconditions(canvas: ServerCanvas, conditions: readonly AgentPrecondition[]): { message: string } | null {
  for (const condition of conditions) {
    const node = canvas.document.nodes.find((entry) => entry.id === condition.nodeId);
    const data = canvas.nodeData[condition.nodeId] as { prompt?: string; taskStatus?: string } | undefined;
    switch (condition.type) {
      case "node-exists":
        if (!node) return { message: `前置条件失败：节点 ${condition.nodeId} 不存在` };
        break;
      case "node-missing":
        if (node) return { message: `前置条件失败：节点 ${condition.nodeId} 已存在` };
        break;
      case "prompt-equals": {
        const current = typeof data?.prompt === "string" ? data.prompt : "";
        if (current !== condition.equals) return { message: `前置条件失败：节点 ${condition.nodeId} 的 prompt 已变化` };
        break;
      }
      case "not-processing":
        if (data?.taskStatus === "processing") return { message: `前置条件失败：节点 ${condition.nodeId} 正在执行` };
        break;
    }
  }
  return null;
}

/**
 * 删除命令的级联影响（后代节点），供全量范围复核。
 *
 * 与领域 reducer 的级联一致：既包含 group `parentId` 后代（`collectWoohaa3CanvasRemovalIds`），
 * 也包含关联边端点，使「单节点越界」不会通过外层 canvasId 合法被放行。
 */
export function collectCascade(canvas: ServerCanvas, commands: readonly CanvasCommand[]): string[] {
  const sink = new Set<string>();
  for (const command of commands) {
    if (command.type !== "node.remove") continue;
    // 领域级联（group 后代 + 空父容器）用同一权威实现，避免两套语义漂移。
    for (const id of collectWoohaa3CanvasRemovalIds(canvas.document.nodes, command.nodeIds, canvas.nodeData)) sink.add(id);
  }
  // 关联边会随端点删除而移除，另一端也必须处于授权范围（含级联出的后代端点）。
  for (const edge of canvas.document.edges) {
    if (sink.has(edge.source)) sink.add(edge.target);
    if (sink.has(edge.target)) sink.add(edge.source);
  }
  return [...sink];
}

export function toScriptError(code: string, message: string, operationIndex?: number, field?: string): CanvasScriptError {
  return canvasScriptError(code, "compile", message, {
    ...(operationIndex !== undefined ? { operationIndex } : {}),
    ...(field !== undefined ? { field } : {})
  });
}

export function stageForCode(code: string): CanvasScriptErrorStage {
  if (code === "revision-conflict" || code === "precondition-failed") return "precondition";
  if (code === "forbidden" || code === "unauthorized") return "authorize";
  return "commit";
}
