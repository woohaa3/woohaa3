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
  type BevyRunFeedbackPrimitive,
  type CanvasNodeRunSummary,
  type CanvasRenderScene,
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
 * - 聚合节点：写 `aggregateRun.active`（运行遮罩），阶段/文案写入场景级 `runFeedback` 原语。
 * - 普通节点：按 createdAt 升序生成有界圆点；当前生效版本用独立装饰（不挤占状态颜色）。
 * - group 与片场不写历史条；片场执行反馈并入 `group.runStatus`，与普通组共用气泡边缘动效。
 */
export function applyRunStateProjection(scene: CanvasRenderScene, input: NodeRunStateProjection): void {
  const summaries = new Map(input.summaries.map((entry) => [entry.nodeId, entry]));
  const recordsByNode = new Map<string, CanvasOperationRecord[]>();
  for (const record of input.records) {
    const list = recordsByNode.get(record.nodeId);
    if (list) list.push(record);
    else recordsByNode.set(record.nodeId, [record]);
  }
  // 保留 owner adapter 声明的运行反馈（无运行状态摘要的节点），只覆盖本宿主投影的节点。
  const feedback: BevyRunFeedbackPrimitive[] = (scene.runFeedback ?? []).filter((entry) => !summaries.has(entry.nodeId));
  for (const node of scene.nodes) {
    const summary = summaries.get(node.id);
    if (node.group) {
      const filmSet = summary?.filmSetFeedback;
      const status = input.groupStatuses?.get(node.id)
        ?? (filmSet ? { label: FILM_SET_RUN_LABELS[filmSet.labelCode], state: FILM_SET_GROUP_STATE[filmSet.phase] } : undefined);
      if (status) node.group.runStatus = status;
      else delete node.group.runStatus;
      continue;
    }
    // 聚合 owner 的反馈统一走通用原语：渲染器只消费阶段/文案码，不识别业务身份。
    const aggregate = summary && "filmSetFeedback" in summary ? summary.filmSetFeedback ?? null : null;
    if (summary && "filmSetFeedback" in summary) {
      node.aggregateRun = { active: aggregate != null && aggregate.phase !== "failed" };
      delete node.historyStrip;
      if (aggregate) {
        feedback.push({
          nodeId: node.id,
          active: aggregate.phase !== "failed",
          phase: aggregate.phase,
          labelCode: aggregate.labelCode,
          operationKey: aggregate.operationKey,
          source: aggregate.source
        });
      }
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
  if (feedback.length > 0) scene.runFeedback = feedback;
  else delete scene.runFeedback;
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
