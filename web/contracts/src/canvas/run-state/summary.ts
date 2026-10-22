/**
 * 统一生成运行状态：聚合节点谓词与摘要归约
 * （change: 2026-10-12-unify-generation-history-strip，design D1/D5）。
 *
 * 纯函数：不依赖 DOM / Node / Yjs，不修改输入，也不产生 canonical 写入。
 *
 * 聚合节点在本 change 中明确指 “复合资产/片场” 与未来的纯模型聚合节点（如游戏炼丹炉）。
 * 当前基线只有片场（规范类型 `composite-asset`）；谓词是唯一权威判定，接入新聚合类型时只需扩展
 * 本函数，不改任何调用方，也 MUST NOT 为一个不存在的类型造占位节点。
 */
import type {
  AggregateRunNodeInput,
  CanvasNodeRunSummary,
  CanvasOperationRecord
} from "./types.js";
import { isActiveOperationState } from "./types.js";
import { COMPOSITE_ASSET_NODE_TYPE } from "../domain/core/composite-asset-identity.js";

/**
 * 是否为聚合运行节点。
 *
 * `composite-asset`（复合资产/片场）在本基线是唯一聚合节点。未来声明为纯模型聚合的宿主节点
 * （例如游戏炼丹炉）接入时在此追加其规范类型；在该类型进入仓库前不得凭猜测添加。
 */
export function isAggregateRunNode(node: AggregateRunNodeInput): boolean {
  return node.type === COMPOSITE_ASSET_NODE_TYPE;
}

/** 归约单个节点的运行摘要。`records` 应是该节点已知的操作记录（任意顺序）。 */
export function summarizeNodeRunState(input: {
  canvasId: string;
  nodeId: string;
  isAggregate: boolean;
  records: readonly CanvasOperationRecord[];
}): CanvasNodeRunSummary {
  const active = input.records.find((record) => isActiveOperationState(record.state)) ?? null;
  return {
    canvasId: input.canvasId,
    nodeId: input.nodeId,
    active,
    isAggregate: input.isAggregate,
    aggregateRunning: input.isAggregate && active !== null
  };
}

/**
 * 按 `(canvasId, nodeId)` 归约一组操作记录为摘要映射（有界）。
 *
 * 传入 `aggregateNodeIds` 标记哪些节点是聚合节点。同一节点的多个操作只保留一个 active 门禁项，
 * 但 `aggregateRunning` 反映该节点是否确有运行中操作。
 */
export function summarizeRunStateByNode(input: {
  canvasId: string;
  records: readonly CanvasOperationRecord[];
  aggregateNodeIds: Iterable<string>;
}): Map<string, CanvasNodeRunSummary> {
  const aggregate = new Set(input.aggregateNodeIds);
  const byNode = new Map<string, CanvasOperationRecord[]>();
  for (const record of input.records) {
    const list = byNode.get(record.nodeId);
    if (list) list.push(record);
    else byNode.set(record.nodeId, [record]);
  }
  const out = new Map<string, CanvasNodeRunSummary>();
  for (const [nodeId, records] of byNode) {
    out.set(
      nodeId,
      summarizeNodeRunState({
        canvasId: input.canvasId,
        nodeId,
        isAggregate: aggregate.has(nodeId),
        records
      })
    );
  }
  return out;
}
