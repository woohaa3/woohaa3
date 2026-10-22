/**
 * 宿主录制任务 → 画布活动浮层
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 5.5 / design D9）。
 *
 * 规则与既有 `shot-reference-activity` 完全一致（不改浮层政策）：
 * - **每次尝试一条**记录：activity id 含 attemptId，重试是新记录；
 * - **进度 5% 分桶**：由宿主的协调器完成，这里只做投影；
 * - **不回填历史**：只在任务事件发生时发布，不提供「拉取最近记录」；
 * - **终态 10 秒移除**：由 `task-activity` 前端 store 持有，宿主不重复实现；
 * - **不写 durable 任务历史**：只发 `extension.activity.updated`。
 *
 * 本文件只做「宿主 job → BackgroundActivityJob」的映射与节流，可在 node 单测。
 */
import type { BackgroundActivityJob } from "./background-activity.js";

/** 宿主任务状态（与 coordinator 的 `RecordingJobState` 同集）。 */
export type HostRecordingState =
  | "queued"
  | "preparing"
  | "rendering"
  | "paused"
  | "encoding"
  | "uploading"
  | "committing"
  | "succeeded"
  | "cancelled"
  | "failed"
  | "stale";

export type HostRecordingActivityInput = {
  jobId: string;
  attemptId: string;
  canvasId: string;
  nodeId: string;
  title: string;
  purpose: "reference" | "export";
  state: HostRecordingState;
  completedFrames: number;
  totalFrames: number;
  /** 失败原因（仅 failed）。 */
  error?: string;
  /** 事件时间（ISO）；同一 id 的乱序事件按它判定。 */
  updatedAt: string;
};

/** 宿主状态 → 浮层状态。 */
export function activityStatus(state: HostRecordingState): BackgroundActivityJob["status"] {
  switch (state) {
    case "queued":
    case "preparing":
      return "queued";
    case "rendering":
    case "paused":
    case "encoding":
    case "uploading":
    case "committing":
      return "running";
    case "succeeded":
      return "succeeded";
    case "cancelled":
    case "stale":
      return "cancelled";
    case "failed":
      return "failed";
  }
}

/** 阶段中文描述（浮层 detail）。 */
export function activityDetail(state: HostRecordingState): string | undefined {
  switch (state) {
    case "preparing":
      return "准备场景";
    case "paused":
      return "等待交互结束";
    case "encoding":
      return "编码中";
    case "uploading":
      return "上传视频中";
    case "committing":
      return "保存视频中";
    case "stale":
      return "内容已更新，本次作废";
    default:
      return undefined;
  }
}

/** 稳定 activity id：每次尝试独立。 */
export function recordingActivityId(input: { jobId: string; attemptId: string }): string {
  return `recording:${input.jobId}:${input.attemptId}`;
}

/**
 * 任务事件 → 活动记录。
 *
 * 进度按 5% 分桶（与协调器一致，双保险：协调器负责「要不要发」，这里保证「发的值」不抖）。
 */
export function toActivityJob(input: HostRecordingActivityInput): BackgroundActivityJob {
  const status = activityStatus(input.state);
  const detail = input.state === "failed" ? input.error : activityDetail(input.state);
  const progress =
    input.totalFrames > 0
      ? Math.min(1, Math.floor((input.completedFrames / input.totalFrames) * 20) / 20)
      : undefined;
  return {
    id: recordingActivityId(input),
    canvasId: input.canvasId,
    kind: "shot-reference-recording",
    title: input.title,
    status,
    ...(progress !== undefined && status === "running" ? { progress } : {}),
    ...(detail ? { detail } : {}),
    nodeId: input.nodeId,
    updatedAt: input.updatedAt
  };
}

/**
 * 有界投影器：按 activity id 去重、拒绝乱序回退、终态不复活。
 *
 * 宿主只保留当前进程内的少量条目（浮层自己负责 10 秒移除），因此这里不需要 TTL。
 */
export class RecordingActivityProjector {
  private readonly published = new Map<string, BackgroundActivityJob>();

  constructor(
    private readonly emit: (job: BackgroundActivityJob) => void,
    private readonly limit = 64
  ) {}

  /** 发布一条事件；被拒绝（重复/乱序/终态复活）返回 false。 */
  publish(input: HostRecordingActivityInput): boolean {
    const job = toActivityJob(input);
    const previous = this.published.get(job.id);
    if (previous) {
      // 终态不复活、旧事件不覆盖新事件。
      if (isTerminal(previous.status) && !isTerminal(job.status)) return false;
      if (previous.updatedAt > job.updatedAt) return false;
      if (previous.status === job.status && previous.progress === job.progress && previous.detail === job.detail) {
        return false;
      }
    }
    this.published.set(job.id, job);
    if (this.published.size > this.limit) {
      // 有界：淘汰最早的一条。
      const oldest = this.published.keys().next().value;
      if (oldest !== undefined) this.published.delete(oldest);
    }
    this.emit(job);
    return true;
  }

  /** 已发布的记录（测试与诊断；**不**用于回填UI）。 */
  entries(): BackgroundActivityJob[] {
    return [...this.published.values()];
  }
}

function isTerminal(status: BackgroundActivityJob["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
