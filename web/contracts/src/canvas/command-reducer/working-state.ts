/**
 * 命令 reducer 的工作副本与运行时任务判定。
 *
 * 自 `command-reducer.ts` 拆出（change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，
 * R12）。所有命令族共享同一可变工作副本语义：命令逐个作用于它，`finalize` 一次性写回规范聚合。
 */
import type { CanvasCommand } from "../commands.js";
import type { CanvasNodeData, ServerCanvas } from "../domain/index.js";
import type { WorkingState } from "./types.js";

export function isCanvasCommandShape(value: unknown): value is CanvasCommand {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

export function toWorkingState(canvas: ServerCanvas): WorkingState {
  return {
    title: canvas.title ?? "",
    nodes: canvas.document.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      ...(node.position ? { position: { ...node.position } } : {}),
      width: node.width,
      height: node.height,
      parentId: node.parentId,
      zIndex: node.zIndex,
      data: {}
    })),
    edges: canvas.document.edges.map((edge) => ({ ...edge, data: { ...edge.data } })),
    nodeData: Object.fromEntries(
      Object.entries(canvas.nodeData).map(([id, data]) => [id, { ...data }])
    ),
    assets: canvas.assets.map((asset) => ({ ...asset })),
    jobs: canvas.jobs.map((job) => ({ ...job }))
  };
}

/** nodeData 读取器（供连接规则判定镜头参考来源；工作副本内按节点 id 读取）。 */
export function workingNodeDataReader(work: WorkingState) {
  return { get: (nodeId: string) => work.nodeData[nodeId] as Record<string, unknown> | undefined };
}

/** 找出集合中仍处于 queued/pending/running 任务的节点；返回第一个命中的 id。 */
export function findActiveRunNode(work: WorkingState, nodeIds: readonly string[]): string | null {
  const target = new Set(nodeIds);
  for (const node of work.nodes) {
    if (!target.has(node.id)) continue;
    const data = work.nodeData[node.id];
    if (!data) continue;
    if (isNodeTaskActive(data)) return node.id;
  }
  // 未被 nodeId 直接覆盖、但 shared job 处于进行中的节点同样受保护。
  for (const job of work.jobs) {
    if (!target.has(job.nodeId)) continue;
    if (job.status === "queued" || job.status === "running" || job.status === "draft") return job.nodeId;
  }
  return null;
}

export function isNodeTaskActive(data: CanvasNodeData): boolean {
  // 任务终态投影只把 taskStatus 置为 successed/failed/cancelled，**不清除** activeRunId
  // （latest-run-wins 仍需保留最近 run 身份）。因此能否删除只看任务状态，而不是 activeRunId 是否存在。
  return data.taskStatus === "pending" || data.taskStatus === "processing";
}

/** 节点是否为复合资产自包含 3D 定义节点（模型/片场/炉体）。 */
export function isModelDefinitionNode(work: WorkingState, nodeId: string): boolean {
  const node = work.nodes.find((entry) => entry.id === nodeId);
  return node?.type === "model3d" || node?.type === "composite-asset";
}
