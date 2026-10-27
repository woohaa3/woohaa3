/**
 * 节点生成历史：同类型节点合并请求/回执契约
 * （change: 2026-10-27-merge-same-type-node-history，任务 1.2 / design D4、D5、D7）。
 *
 * 合并写面只在 Canvas Service：前端只提交来源/目标与操作身份，内容切换、历史复制与
 * 来源删除全部由服务端在同一画布批次内完成。回执只含稳定计数与修订，不含历史正文。
 */

/** 合并请求（HTTP body；目标节点在路由段内）。 */
export type MergeNodeHistoryRequest = {
  /** 被合并并被删除的来源节点。 */
  sourceNodeId: string;
  /** 调用方生成的操作身份；同一身份重试幂等。 */
  operationId: string;
  /** 可选并发保护：调用方看到的来源当前内容身份。 */
  expectedSourceCurrentIdentity?: string;
  /** 可选并发保护：调用方看到的目标当前内容身份。 */
  expectedTargetCurrentIdentity?: string;
};

/** 合并回执。 */
export type MergeNodeHistoryReceipt = {
  targetNodeId: string;
  sourceNodeId: string;
  /** 批次提交后的画布修订；幂等重试返回首次修订。 */
  revision: number;
  /** 本次真正新增到目标的历史条目数。 */
  copied: number;
  /** 主键已存在而未新增的条目数；相同内容不再去重，只在同一操作重试遗留时出现。 */
  duplicates: number;
  /** 合并后容量清理淘汰的条目数（当前版本受保护）。 */
  evicted: number;
  /** 命中同一操作身份的既有回执时为 true（不重复复制/切换）。 */
  alreadyMerged: boolean;
};

/** 合并失败的可读原因分类（跨进程按字符串判定）。 */
export const NODE_MERGE_FAILURE_REASONS = [
  "unknown-node",
  "invalid-node-type",
  "conflict",
  "unrecoverable",
  "no-current-version",
  "merge-failed"
] as const;

export type NodeMergeFailureReason = (typeof NODE_MERGE_FAILURE_REASONS)[number];
