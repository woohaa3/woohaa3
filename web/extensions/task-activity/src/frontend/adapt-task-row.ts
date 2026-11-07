/**
 * 生成任务 → `ActivityRow`（change: 2026-10-22-unify-task-activity-rows，任务 1.2 / design D1）。
 *
 * 纯函数：不读时间、不订阅、不写 store。「是否进行中」用 `isActiveTaskState` 判定，这是任务
 * 来源语义，不上提到面板层。主行文案优先用装配注入的 `resolveTaskDisplay`，缺省回退 modelKey。
 */
import { isActiveTaskState, taskMediaReadiness, type CanvasTaskActivity } from "@woohaa3/contracts";
import type { ActivityFeedItem } from "./store.js";
import {
  TASK_STATE_LABELS,
  TASK_STATE_TONES,
  fractionProgress,
  type ActivityRow,
  type ActivityRowCapabilities
} from "./rows.js";

const MODEL_TYPE_LABELS: Record<NonNullable<CanvasTaskActivity["modelType"]>, string> = {
  language: "文本",
  image: "图片",
  video: "视频",
  audio: "音频"
};

/** 缺省主行文案：优先 modelKey，其次模型类型，最后通用「任务」。 */
export function defaultTaskTitle(item: Pick<CanvasTaskActivity, "modelKey" | "modelType">): string {
  if (item.modelKey) return item.modelKey;
  if (item.modelType) return MODEL_TYPE_LABELS[item.modelType];
  return "任务";
}

export function taskRowKey(item: Pick<ActivityFeedItem, "runId">): string {
  return `task:${item.runId}`;
}

export function adaptTaskRow(item: ActivityFeedItem, capabilities: ActivityRowCapabilities = {}): ActivityRow {
  const active = isActiveTaskState(item.state);
  const readiness = taskMediaReadiness(item);
  const preparing = readiness === "preparing";
  const display = capabilities.resolveTaskDisplay?.(item);
  const title = display?.primary ?? defaultTaskTitle(item);
  // 次行沿用既有语义：注入的展示解析优先，其次 modelKey，最后明确的兜底文案。
  const secondary = display?.secondary || item.modelKey || "模型信息暂不可用";
  const locate = capabilities.locateNode && item.nodeId ? () => capabilities.locateNode!(item.nodeId) : undefined;
  /**
   * 主行点击优先按确切 run 打开 Agent 详情；无关联（普通 Task）回退作品生成历史。
   * `openTaskDetail` 返回 `false`/拒绝都视为「无 Agent 关联」，绝不伪造对话。
   */
  const openDetail = capabilities.openTaskDetail
    ? () => {
      void Promise.resolve(capabilities.openTaskDetail!(item))
        .then((opened) => {
          if (!opened) capabilities.openHistory?.(item);
        })
        .catch(() => capabilities.openHistory?.(item));
    }
    : capabilities.openHistory
      ? () => capabilities.openHistory!(item)
      : undefined;
  return {
    key: taskRowKey(item),
    kind: "task",
    title,
    secondary,
    status: preparing ? "媒体准备中" : TASK_STATE_LABELS[item.state],
    state: item.state,
    tone: preparing ? "active" : TASK_STATE_TONES[item.state],
    ...(active && fractionProgress(item.progress) !== undefined ? { progress: fractionProgress(item.progress) } : {}),
    nodeId: item.nodeId,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    active,
    actions: {
      close: !active,
      ...(locate ? { locate } : {}),
      ...(openDetail ? { openDetail } : {})
    },
    source: { kind: "task", item }
  };
}
