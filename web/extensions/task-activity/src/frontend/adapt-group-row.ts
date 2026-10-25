/**
 * 组创作读模型 → `ActivityRow`（change: 2026-10-22-unify-task-activity-rows，任务 1.2 / design D1/D2）。
 *
 * 组记录来自宿主 `canvasGroupRuns` 的**整表替换**，不是增量事件；「进行中」直接取
 * `CanvasGroupRun.active`（宿主已按 preparing|root-created|accepted|queued|running|
 * committing|unknown 算出）。组专属动作只在装配注入能力时出现，记录只携带动作函数引用，
 * 因此渲染层不需要按来源分支取 props（design D6）。
 */
import type { CanvasGroupRun } from "@woohaa3/frontend/extension-api";
import {
  GROUP_STOPPABLE_STATUSES,
  groupRunTone,
  type ActivityRow,
  type ActivityRowCapabilities
} from "./rows.js";

export function groupRowKey(run: Pick<CanvasGroupRun, "requestId">): string {
  return `group:${run.requestId}`;
}

/** 该组记录是否允许停止（运行中且已建立对话）。 */
export function canStopGroupRun(run: CanvasGroupRun): boolean {
  if (!run.conversationId) return false;
  return (GROUP_STOPPABLE_STATUSES as readonly string[]).includes(run.status);
}

/** 该组记录是否允许「重试原请求」（首轮尚未落地，且不是目标缺失导致的失败）。 */
export function canRetryGroupRun(run: CanvasGroupRun): boolean {
  if (!run.creation || run.turn || run.creation.turnId) return false;
  return run.creation.error?.code !== "group-target-missing";
}

export function adaptGroupRow(
  run: CanvasGroupRun,
  capabilities: ActivityRowCapabilities = {},
  context: { selected?: boolean } = {}
): ActivityRow {
  const group = capabilities.group ?? {};
  const writable = group.writable?.() ?? false;
  const locateNode = capabilities.locateNode;
  const stop = group.action && canStopGroupRun(run)
    ? () => group.action!(run, "stop")
    : undefined;
  const retry = group.action && canRetryGroupRun(run)
    ? () => group.action!(run, "retry")
    : undefined;
  const verify = group.action ? () => group.action!(run, "refresh") : undefined;
  const openConversation = group.openConversation && run.conversationId
    ? async () => {
      await group.openConversation!(run);
    }
    : undefined;
  const locate = locateNode ? () => locateNode(run.rootGroupId) : undefined;
  const title = group.resolveTitle?.(run.rootGroupId) || "节点搭建";
  return {
    key: groupRowKey(run),
    kind: "group",
    title,
    status: run.label,
    state: run.status,
    tone: groupRunTone(run.status),
    ...(run.error ? { detail: run.error } : {}),
    nodeId: run.rootGroupId,
    createdAt: run.createdAt,
    updatedAt: run.createdAt,
    active: run.active,
    ...(context.selected ? { selected: true } : {}),
    actions: {
      close: !run.active,
      ...(locate ? { locate } : {}),
      ...(stop ? { stop } : {}),
      ...(retry ? { retry } : {}),
      ...(verify ? { verify } : {}),
      ...(openConversation ? { openConversation } : {}),
      writable,
      pinOnOpen: true,
      autoOpenOnSelect: true
    },
    source: { kind: "group", run }
  };
}
