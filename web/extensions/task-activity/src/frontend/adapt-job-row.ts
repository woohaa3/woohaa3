/**
 * 扩展后台活动 → `ActivityRow`（change: 2026-10-22-unify-task-activity-rows，任务 1.2 / design D1）。
 *
 * 纯函数。「进行中」由 `queued|running` 判定（来源语义）。后台活动不打开任务历史或 Agent
 * 详情，只提供所属节点定位；失败原因经 `detail` 进入统一的详情分支。
 */
import type { BackgroundActivityJob } from "@woohaa3/contracts";
import type { BackgroundFeedJob } from "./store.js";
import {
  BACKGROUND_KIND_LABELS,
  BACKGROUND_STATUS_LABELS,
  BACKGROUND_STATUS_TONES,
  clampProgress,
  type ActivityRow,
  type ActivityRowCapabilities
} from "./rows.js";

export function isActiveBackgroundJob(job: Pick<BackgroundActivityJob, "status">): boolean {
  return job.status === "queued" || job.status === "running";
}

export function jobRowKey(job: Pick<BackgroundActivityJob, "id">): string {
  return `job:${job.id}`;
}

export function adaptJobRow(job: BackgroundFeedJob, capabilities: ActivityRowCapabilities = {}): ActivityRow {
  const active = isActiveBackgroundJob(job);
  const title = `${BACKGROUND_KIND_LABELS[job.kind]} · ${job.title}`;
  const detail = job.detail
    ?? (job.status === "failed" ? "镜头录制失败，未返回具体原因。" : "");
  const locateNode = capabilities.locateNode;
  const nodeId = job.nodeId;
  const locate = locateNode && nodeId ? () => locateNode(nodeId) : undefined;
  return {
    key: jobRowKey(job),
    kind: "job",
    title,
    status: BACKGROUND_STATUS_LABELS[job.status],
    state: job.status,
    tone: BACKGROUND_STATUS_TONES[job.status],
    ...(active && clampProgress(job.progress) !== undefined ? { progress: clampProgress(job.progress) } : {}),
    ...(job.nodeId ? { nodeId: job.nodeId } : {}),
    ...(detail ? { detail } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    active,
    actions: {
      close: !active,
      ...(locate ? { locate } : {})
    },
    source: { kind: "job", job }
  };
}
