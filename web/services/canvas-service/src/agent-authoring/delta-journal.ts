/**
 * 有界 revision delta 日志
 * （change: add-agent-canvas-authoring-mcp，任务 3.4）。
 *
 * 保存最近 N 个 revision 的节点/边变化，供 `get_canvas_changes` 计算增量。超出保留窗口的
 * sinceRevision 返回 resetRequired，绝不从部分 command log 猜测（spec「Agent 增量只返回
 * 可证明完整的变化」）。
 *
 * 进程内、有界、可重建的派生日志：权威事实始终是 Y.Doc / projection；日志丢失只导致
 * resetRequired。刻意不持久化（MCP 不缓存权威，Canvas 侧也不需要跨重启保证增量）。
 */
import type { AgentCanvasDelta, ServerCanvas } from "@woohaa3/contracts";
import { computeAgentDelta } from "@woohaa3/contracts";

/** 单画布保留的 revision 窗口大小。 */
export const AGENT_DELTA_WINDOW = 100;

/** 合并后的增量载荷（不含 protocol/identity 字段，由调用方补齐）。 */
export type AgentDeltaPayload = Pick<
  AgentCanvasDelta,
  "nodes" | "edges" | "deletedNodeIds" | "deletedEdgeIds"
>;

type DeltaEntry = {
  fromRevision: number;
  toRevision: number;
  delta: AgentDeltaPayload;
};

export class AgentDeltaJournal {
  private readonly windowSize: number;
  private readonly byCanvas = new Map<string, DeltaEntry[]>();

  constructor(windowSize = AGENT_DELTA_WINDOW) {
    this.windowSize = windowSize;
  }

  /** 确保画布有一条空日志（不改变窗口起点语义：起点即第一条 delta 的 fromRevision）。 */
  seed(canvasId: string): void {
    if (!this.byCanvas.has(canvasId)) this.byCanvas.set(canvasId, []);
  }

  /** 记录一次 revision 变化（before → after）。 */
  record(canvasId: string, before: ServerCanvas, after: ServerCanvas): void {
    const entries = this.byCanvas.get(canvasId) ?? [];
    entries.push({
      fromRevision: before.revision,
      toRevision: after.revision,
      delta: computeAgentDelta(before, after)
    });
    while (entries.length > this.windowSize) entries.shift();
    this.byCanvas.set(canvasId, entries);
  }

  /**
   * 计算 sinceRevision 之后的增量。
   *
   * 返回 null 表示 sinceRevision 不可证明完整（未知画布、早于窗口起点或不连续），
   * 调用方据此返回 resetRequired。
   */
  deltaFor(canvasId: string, sinceRevision: number, currentRevision: number): AgentDeltaPayload | null {
    if (sinceRevision === currentRevision) {
      return { nodes: [], edges: [], deletedNodeIds: [], deletedEdgeIds: [] };
    }
    const entries = this.byCanvas.get(canvasId);
    if (!entries) return null;
    const relevant = entries.filter((entry) => entry.toRevision > sinceRevision);
    if (relevant.length === 0) return null;
    // 首个相关增量必须从 sinceRevision 开始，否则中间有缺口 → 不可证明完整。
    if (relevant[0]!.fromRevision !== sinceRevision) return null;
    for (let index = 1; index < relevant.length; index += 1) {
      if (relevant[index]!.fromRevision !== relevant[index - 1]!.toRevision) return null;
    }
    if (relevant[relevant.length - 1]!.toRevision !== currentRevision) return null;

    const nodeById = new Map<string, AgentDeltaPayload["nodes"][number]>();
    const edgeById = new Map<string, AgentDeltaPayload["edges"][number]>();
    const deletedNodeIds = new Set<string>();
    const deletedEdgeIds = new Set<string>();
    for (const entry of relevant) {
      for (const node of entry.delta.nodes) nodeById.set(node.nodeId, node);
      for (const edge of entry.delta.edges) edgeById.set(edge.edgeId, edge);
      for (const deleted of entry.delta.deletedNodeIds) {
        nodeById.delete(deleted);
        deletedNodeIds.add(deleted);
      }
      for (const deleted of entry.delta.deletedEdgeIds) {
        edgeById.delete(deleted);
        deletedEdgeIds.add(deleted);
      }
    }
    return {
      nodes: [...nodeById.values()],
      edges: [...edgeById.values()],
      deletedNodeIds: [...deletedNodeIds].filter((id) => !nodeById.has(id)).sort(),
      deletedEdgeIds: [...deletedEdgeIds].filter((id) => !edgeById.has(id)).sort()
    };
  }
}
