/**
 * 运行状态 → Bevy 节点历史条/聚合遮罩投影
 * （change: 2026-10-12-unify-generation-history-strip，design D4/D5）。
 *
 * 纯函数：把有界的统一运行状态摘要与操作记录投影为节点上的 `historyStrip`/`aggregateRun`
 * 呈现。不读取完整历史、不写 canonical、不进入 Y.Doc。
 */
import {
  FILM_SET_RUN_LABELS, mergeNodeExecutionPresentation, nodeExecutionWindow, showNodeExecutionDots,
  type FilmSetRunPhase,
  type NodeGenerationHistoryListItem,
  type BevyHistoryDotState,
  type BevyRenderNode,
  type CanvasNodeRunSummary,
  type CanvasOperationRecord,
  type CanvasOperationState
} from "@woohaa3/contracts";

/** 投影输入（有界）：每个节点一条摘要 + 每个操作一条记录 + 当前版本操作身份。 */
export type NodeRunStateProjection = {
  groupStatuses?: ReadonlyMap<string, { label: string; state: string }>;
  summaries: readonly CanvasNodeRunSummary[];
  records: readonly CanvasOperationRecord[];
  currentOperationByNode?: ReadonlyMap<string, string>;
  versionsByNode?: ReadonlyMap<string, readonly NodeGenerationHistoryListItem[]>;
  selectedByNode?: ReadonlyMap<string, string>;
};

/**
 * 片场反馈阶段 → group 运行状态。
 *
 * 迁移后的片场是带 `filmSetGroup` marker 的 group，运行中的气泡边缘动效与状态标识由
 * `group.runStatus` 驱动。`submitting` 在 group 词汇里对应准备阶段，其余阶段同名复用。
 */
const FILM_SET_GROUP_STATE: Record<FilmSetRunPhase, string> = {
  submitting: "preparing",
  queued: "queued",
  running: "running",
  committing: "committing",
  failed: "failed"
};

/**
 * 就地投影运行状态到 render scene。
 *
 * - 聚合节点：写 `aggregateRun.active`（运行遮罩），不加历史条。
 * - 普通节点：按 createdAt 升序生成有界圆点；当前生效版本用独立装饰（不挤占状态颜色）。
 * - group 与片场不写历史条；片场执行反馈并入 `group.runStatus`，与普通组共用气泡边缘动效。
 */
export function applyRunStateProjection(nodes: readonly BevyRenderNode[], input: NodeRunStateProjection): void {
  const summaries = new Map(input.summaries.map((entry) => [entry.nodeId, entry]));
  const recordsByNode = new Map<string, CanvasOperationRecord[]>();
  for (const record of input.records) {
    const list = recordsByNode.get(record.nodeId);
    if (list) list.push(record);
    else recordsByNode.set(record.nodeId, [record]);
  }
  for (const node of nodes) {
    const summary = summaries.get(node.id);
    if (node.group) {
      const filmSet = summary?.filmSetFeedback;
      const status = input.groupStatuses?.get(node.id)
        ?? (filmSet ? { label: FILM_SET_RUN_LABELS[filmSet.labelCode], state: FILM_SET_GROUP_STATE[filmSet.phase] } : undefined);
      if (status) node.group.runStatus = status;
      else delete node.group.runStatus;
      continue;
    }
    if (summary && "filmSetFeedback" in summary) {
      node.aggregateRun = { active: summary.filmSetFeedback != null && summary.filmSetFeedback.phase !== "failed", filmSet: summary.filmSetFeedback ?? undefined };
      delete node.historyStrip;
      continue;
    }
    if (summary?.isAggregate || (node.compositeAsset && node.busy)) {
      // 部分内容交付任务以规范节点 busy 回流，和 Agent operation 共用聚合运行遮罩。
      node.aggregateRun = { active: Boolean(summary?.aggregateRunning || node.busy) };
      continue;
    }
    // 运行态呈现以统一运行状态为准（change: show-agent-turn-running-state-on-node）：
    // Task 链路在 canonical `taskStatus` 回流前、Agent 回合全程都只有本读模型有运行态，
    // 因此这里直接点亮 `busy`，让节点与图片/视频节点一致显示进度环（无百分比时按节点种类估算）。
    const records = recordsByNode.get(node.id) ?? (summary?.active ? [summary.active] : []);
    const items = mergeNodeExecutionPresentation(records, input.versionsByNode?.get(node.id) ?? []);
    const selectedId = input.selectedByNode?.get(node.id);
    const selected = items.find(item => item.presentationId === selectedId)
      ?? (selectedId ? undefined : [...items].reverse().find(item => item.state === "running" || item.state === "queued") ?? items.find(item => item.current));
    if (selectedId || items.length) {
      node.busy = selected?.state === "running" || selected?.state === "queued";
      node.progress = node.busy ? selected?.progress ?? 0 : 0;
      // 节点进度环的估算起点与活动面板同一条记录：都用该 run 被观察到的创建时刻
      // （change: 2026-10-31-unify-node-and-activity-progress，design D2）。
      const startedAt = node.busy ? operationStartOf(selected, records) : undefined;
      if (startedAt !== undefined) node.progressStartedAt = startedAt;
      else delete node.progressStartedAt;
    } else if (summary?.active) node.busy = true;
    const visible = nodeExecutionWindow(items, 24, selectedId);
    if (!showNodeExecutionDots(visible)) { delete node.historyStrip; continue; }
    node.historyStrip = {
      dots: visible.map(item => ({ state: item.state, current: item.current, selected: item === selected,
        presentationId: item.presentationId, entryId: item.entryId, operationId: item.operationId,
        recoverable: item.recoverable })),
      truncated: items.length - visible.length
    };
  }
}

/**
 * 该运行被观察到的开始时刻（epoch 毫秒）；无法确定时返回 `undefined`。
 *
 * 取活动记录（与活动面板同一条）的 `createdAt`，它是两端唯一共享的时间锚点。**不**用
 * `updatedAt`：进度更新会推进它，起点一旦漂移节点进度就会回退。
 */
function operationStartOf(
  selected: { operationId?: string; createdAt: string } | undefined,
  records: readonly CanvasOperationRecord[]
): number | undefined {
  const record = selected?.operationId === undefined
    ? undefined
    : records.find((entry) => entry.operationId === selected.operationId);
  const createdAt = record?.createdAt ?? selected?.createdAt;
  if (createdAt === undefined) return undefined;
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 统一操作状态 → 历史条圆点状态。 */
export function dotState(state: CanvasOperationState): BevyHistoryDotState {
  switch (state) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    case "partial":
      return "partial";
  }
}
