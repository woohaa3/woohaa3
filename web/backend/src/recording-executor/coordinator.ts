/**
 * 宿主录制任务协调器
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 5.1 / 5.3 / 5.5 / 6.4）。
 *
 * 职责：
 * - 内存任务状态机（不写 durable 任务历史），幂等 request/job/attempt/epoch；
 * - 单设备执行 claim：同一时刻只有一个 dispatch，参考任务在帧边界让路；
 * - `cancel` 与进入 `committing` 线性化：先到者胜出，另一个得到 `too-late`；
 * - 进度按 5% 节流，每 attempt 一条活动记录，终态不回退。
 *
 * 不做：编码/渲染（执行器做）、上传字节（由注入的 `upload` 做）、领域命令构造
 * （由内容扩展的 `planCommit` 做）。全部协作方都可注入，便于无 GPU/无设备单测。
 */
import type { BackgroundActivityJob } from "@woohaa3/contracts";

/** 宿主可见生命周期。 */
export type RecordingJobState =
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

export const RECORDING_TERMINAL_STATES: readonly RecordingJobState[] = [
  "succeeded",
  "cancelled",
  "failed",
  "stale"
];

export function isTerminalState(state: RecordingJobState): boolean {
  return RECORDING_TERMINAL_STATES.includes(state);
}

/** 失败阶段（与 proto `RecordingErrorStage` 的符号一致）。 */
export type RecordingFailureStage =
  | "RECORDING_ERROR_STAGE_CAPABILITY"
  | "RECORDING_ERROR_STAGE_COMPILE"
  | "RECORDING_ERROR_STAGE_RESOURCE_FETCH"
  | "RECORDING_ERROR_STAGE_DECODE"
  | "RECORDING_ERROR_STAGE_FRAME_READY"
  | "RECORDING_ERROR_STAGE_READBACK"
  | "RECORDING_ERROR_STAGE_ENCODE"
  | "RECORDING_ERROR_STAGE_MUX"
  | "RECORDING_ERROR_STAGE_UPLOAD"
  | "RECORDING_ERROR_STAGE_COMMIT"
  | "RECORDING_ERROR_STAGE_EXECUTOR_LOST";

export type RecordingJobError = {
  stage: RecordingFailureStage;
  code: string;
  message: string;
  frameIndex?: number;
  sampleTime?: number;
  subjectId?: string;
  transient: boolean;
};

export type RecordingJobIdentity = {
  jobId: string;
  attemptId: string;
  executorInstanceId: string;
  executionEpoch: number;
  snapshotHash: string;
  contentIdentity: string;
  profileKey: string;
};

export type RecordingJobRecord = {
  identity: RecordingJobIdentity;
  purpose: "reference" | "export";
  canvasId: string;
  nodeId: string;
  clipId: string;
  state: RecordingJobState;
  completedFrames: number;
  totalFrames: number;
  error?: RecordingJobError;
  /** 是否已进入提交（取消不再是「成功」而是 `too-late`）。 */
  committing: boolean;
  /** 已发布的最近一次进度百分比（5% 节流）。 */
  lastReportedPercent: number;
  createdAt: number;
  updatedAt: number;
  /** 活动记录 id：每个 attempt 独立。 */
  activityId: string;
};

export type RecordingJobCoordinatorOptions = {
  now?: () => number;
  /** 终态记录保留上限（默认 256）。 */
  terminalLimit?: number;
  /** 终态记录保留时长（默认 10 分钟）。 */
  terminalTtlMs?: number;
  /** 参考任务的并排等待上限；超出返回 busy。 */
  maxQueued?: number;
  /** 活动事件出口（画布活动浮层）。 */
  publishActivity?: (job: BackgroundActivityJob) => void;
  logger?: (event: Record<string, unknown>) => void;
};

/** 提交/取消的裁定结果。 */
export type RecordingCancelResult =
  | { ok: true; cancelled: true }
  | { ok: false; code: "recording-too-late"; message: string }
  | { ok: false; code: "recording-unknown-job"; message: string };

export type RecordingJobEvent =
  | { kind: "progress"; completedFrames: number; totalFrames: number; sampleTime: number }
  | { kind: "state"; state: RecordingJobState; error?: RecordingJobError }
  | { kind: "terminal"; state: RecordingJobState; error?: RecordingJobError };

/**
 * 内存任务协调器。
 *
 * 所有状态迁移都经过 `transition`：终态不可复活，旧 attempt 的事件被丢弃。
 */
export class RecordingJobCoordinator {
  private readonly jobs = new Map<string, RecordingJobRecord>();
  /** 被新 attempt 取代的旧记录（仅用于诊断/重连查询，不参与主键查找）。 */
  private readonly superseded = new Map<string, RecordingJobRecord>();
  private readonly order: string[] = [];
  private readonly now: () => number;
  private readonly terminalLimit: number;
  private readonly terminalTtlMs: number;
  private readonly maxQueued: number;
  private readonly publishActivity: (job: BackgroundActivityJob) => void;
  private readonly log: (event: Record<string, unknown>) => void;

  constructor(options: RecordingJobCoordinatorOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.terminalLimit = Math.max(1, options.terminalLimit ?? 256);
    this.terminalTtlMs = Math.max(1_000, options.terminalTtlMs ?? 10 * 60_000);
    this.maxQueued = Math.max(1, options.maxQueued ?? 64);
    this.publishActivity = options.publishActivity ?? (() => undefined);
    this.log = options.logger ?? (() => undefined);
  }

  /** 已跟踪任务（含终态保留窗内的记录）。 */
  list(): RecordingJobRecord[] {
    this.reap();
    const live = this.order
      .map(jobId => this.jobs.get(jobId))
      .filter((job): job is RecordingJobRecord => job !== undefined);
    return [...this.superseded.values(), ...live];
  }

  get(jobId: string): RecordingJobRecord | null {
    return this.jobs.get(jobId) ?? null;
  }

  /** 按画布查询当前任务（页面重连用）；不回填历史。 */
  listForCanvas(canvasId: string): RecordingJobRecord[] {
    return this.list().filter(job => job.canvasId === canvasId);
  }

  /** 排队中的任务数。 */
  queuedCount(): number {
    return this.list().filter(job => !isTerminalState(job.state)).length;
  }

  /**
   * 接受一个新任务；同一 (jobId, attemptId, epoch) 重复提交返回已有记录（幂等）。
   *
   * `queued` 上限只作用于参考任务：显式导出不合并用户有意的多次请求。
   */
  accept(input: {
    identity: RecordingJobIdentity;
    purpose: "reference" | "export";
    canvasId: string;
    nodeId: string;
    clipId: string;
    totalFrames: number;
    title: string;
  }): { ok: true; job: RecordingJobRecord; duplicate: boolean } | { ok: false; code: string; message: string } {
    const existing = this.jobs.get(input.identity.jobId);
    if (existing) {
      if (
        existing.identity.attemptId === input.identity.attemptId &&
        existing.identity.executorInstanceId === input.identity.executorInstanceId &&
        existing.identity.executionEpoch === input.identity.executionEpoch
      ) {
        return { ok: true, job: existing, duplicate: true };
      }
      // 新 attempt：旧记录标记为 stale，避免旧结果继续写入。旧记录保留在列表里用于诊断，
      // 但换到独立键上，让新 attempt 使用主键。
      if (!isTerminalState(existing.state)) this.transition(existing, "stale", undefined);
      this.jobs.delete(existing.identity.jobId);
      this.superseded.set(existing.identity.jobId, existing);
    }
    if (input.purpose === "reference" && this.queuedCount() >= this.maxQueued) {
      return { ok: false, code: "recording-busy", message: "等待中的录制任务已达上限，请稍后重试" };
    }
    const now = this.now();
    const job: RecordingJobRecord = {
      identity: input.identity,
      purpose: input.purpose,
      canvasId: input.canvasId,
      nodeId: input.nodeId,
      clipId: input.clipId,
      state: "queued",
      completedFrames: 0,
      totalFrames: Math.max(0, input.totalFrames),
      committing: false,
      lastReportedPercent: 0,
      createdAt: now,
      updatedAt: now,
      activityId: `recording:${input.identity.jobId}:${input.identity.attemptId}`
    };
    this.jobs.set(job.identity.jobId, job);
    this.order.push(job.identity.jobId);
    this.publish(job, input.title, "queued", 0);
    return { ok: true, job, duplicate: false };
  }

  /**
   * 应用执行器事件。
   *
   * 终态后到达的 progress/state 一律丢弃（不复活）；identity 不匹配的事件也丢弃。
   */
  apply(jobId: string, identity: RecordingJobIdentity, event: RecordingJobEvent): {
    ok: boolean;
    reason?: "unknown-job" | "stale-identity" | "terminal";
  } {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, reason: "unknown-job" };
    if (!sameAttempt(job.identity, identity)) return { ok: false, reason: "stale-identity" };
    if (isTerminalState(job.state)) return { ok: false, reason: "terminal" };
    if (event.kind === "progress") {
      job.completedFrames = Math.max(0, Math.min(event.completedFrames, job.totalFrames || event.completedFrames));
      if (this.shouldPublishProgress(job)) {
        this.publish(job, this.titleFor(job), statusFor(job.state), this.percentOf(job));
      }
      job.updatedAt = this.now();
      return { ok: true };
    }
    if (event.kind === "state") {
      this.transition(job, event.state, event.error);
      return { ok: true };
    }
    this.transition(job, event.state, event.error);
    return { ok: true };
  }

  /** 标记进入 committing；此后 cancel 只能得到 `too-late`。 */
  beginCommit(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || isTerminalState(job.state)) return false;
    job.committing = true;
    this.transition(job, "committing", undefined);
    return true;
  }

  /**
   * 取消裁定：与进入 committing 线性化。
   *
   * 已在 committing/终态 → `too-late`；已终态也可以直接报告终态事实而不是「取消成功」。
   */
  cancel(jobId: string, reason = "用户取消"): RecordingCancelResult {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, code: "recording-unknown-job", message: "任务不存在或已过期" };
    if (job.committing || job.state === "committing") {
      return { ok: false, code: "recording-too-late", message: "任务已进入保存阶段，无法取消" };
    }
    if (isTerminalState(job.state)) {
      if (job.state === "succeeded") {
        return { ok: false, code: "recording-too-late", message: "任务已提交成功，无法取消" };
      }
      return { ok: true, cancelled: true };
    }
    this.transition(job, "cancelled", {
      stage: "RECORDING_ERROR_STAGE_CAPABILITY",
      code: "recording-cancelled",
      message: reason,
      transient: false
    });
    return { ok: true, cancelled: true };
  }

  /** 让参考任务在帧边界让路（显式导出/交互优先）。 */
  pause(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.state !== "rendering") return false;
    this.transition(job, "paused", undefined);
    return true;
  }

  /** 恢复参考任务。 */
  resume(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.state !== "paused") return false;
    this.transition(job, "rendering", undefined);
    return true;
  }

  /** 执行器失联：所有未终结任务明确失败，不留永久等待。 */
  executorLost(executorInstanceId: string, message = "录制执行器失联"): number {
    let affected = 0;
    for (const job of this.list()) {
      if (isTerminalState(job.state)) continue;
      if (job.identity.executorInstanceId !== executorInstanceId) continue;
      this.transition(job, "failed", {
        stage: "RECORDING_ERROR_STAGE_EXECUTOR_LOST",
        code: "recording-executor-lost",
        message,
        transient: false
      });
      affected += 1;
    }
    return affected;
  }

  /** 终态记录数量与年龄清理（不写 durable 历史）。 */
  reap(): number {
    const now = this.now();
    let removed = 0;
    const terminals: RecordingJobRecord[] = [];
    for (const job of this.jobs.values()) {
      const terminal = isTerminalState(job.state);
      if (terminal) terminals.push(job);
      if (terminal && now - job.updatedAt > this.terminalTtlMs) {
        if (this.jobs.delete(job.identity.jobId)) removed += 1;
      }
    }
    for (const [jobId, job] of this.superseded) {
      if (now - job.updatedAt > this.terminalTtlMs) {
        this.superseded.delete(jobId);
        removed += 1;
      }
    }
    if (terminals.length > this.terminalLimit) {
      const surplus = terminals
        .slice()
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(0, terminals.length - this.terminalLimit);
      for (const job of surplus) {
        if (this.jobs.delete(job.identity.jobId)) removed += 1;
      }
    }
    if (removed > 0) {
      for (let index = this.order.length - 1; index >= 0; index -= 1) {
        if (!this.jobs.has(this.order[index]!)) this.order.splice(index, 1);
      }
    }
    return removed;
  }

  private transition(job: RecordingJobRecord, next: RecordingJobState, error?: RecordingJobError): void {
    if (isTerminalState(job.state)) return;
    job.state = next;
    job.updatedAt = this.now();
    if (error) job.error = error;
    if (isTerminalState(next)) {
      job.committing = next === "succeeded" ? true : job.committing;
      this.publish(job, this.titleFor(job), statusFor(next), this.percentOf(job), error?.message);
    } else {
      this.publish(job, this.titleFor(job), statusFor(next), this.percentOf(job));
    }
    this.log({ event: "recording-job-state", jobId: job.identity.jobId, state: next });
  }

  private percentOf(job: RecordingJobRecord): number {
    if (job.totalFrames <= 0) return 0;
    return Math.min(100, Math.round((job.completedFrames / job.totalFrames) * 100));
  }

  /**
   * 5% 节流：同一 attempt 只在跨过 5% 桶或终态时发布。
   *
   * 首次 progress 一定发布（从 0 开始）。
   */
  private shouldPublishProgress(job: RecordingJobRecord): boolean {
    const percent = this.percentOf(job);
    if (percent >= job.lastReportedPercent + 5 || percent === 0 || percent === 100) {
      job.lastReportedPercent = Math.max(job.lastReportedPercent, percent);
      return true;
    }
    return false;
  }

  private titleFor(job: RecordingJobRecord): string {
    return this.titles.get(job.identity.jobId) ?? "片场录制";
  }

  private readonly titles = new Map<string, string>();

  /** 记录展示标题（活动浮层与文件名）。 */
  setTitle(jobId: string, title: string): void {
    this.titles.set(jobId, title);
  }

  /**
   * 读取展示标题（状态投影用）。
   *
   * 标题属于任务而非某次查询的上下文：取消会清掉上下文，这里仍能给出同一标题。
   * 任务已被清理时返回 `undefined`，调用方自带兜底文案。
   */
  titleOf(jobId: string): string | undefined {
    return this.titles.get(jobId);
  }

  private publish(
    job: RecordingJobRecord,
    title: string,
    status: BackgroundActivityJob["status"],
    percent: number,
    detail?: string
  ): void {
    this.titles.set(job.identity.jobId, title);
    this.publishActivity({
      id: job.activityId,
      canvasId: job.canvasId,
      kind: "shot-reference-recording",
      title,
      status,
      progress: percent / 100,
      ...(detail ? { detail } : {}),
      nodeId: job.nodeId,
      updatedAt: new Date(this.now()).toISOString()
    });
  }
}

function sameAttempt(current: RecordingJobIdentity, incoming: RecordingJobIdentity): boolean {
  return (
    current.jobId === incoming.jobId &&
    current.attemptId === incoming.attemptId &&
    current.executorInstanceId === incoming.executorInstanceId &&
    current.executionEpoch === incoming.executionEpoch
  );
}

/** 任务状态 → 活动浮层状态。 */
export function statusFor(state: RecordingJobState): BackgroundActivityJob["status"] {
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
