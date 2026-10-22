/**
 * 镜头参考录制的**调度器**（触发边界与串行执行）
 * （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 8.3 / design D9）。
 *
 * 把画布/聚焦变化连到 dirty 队列（`ShotReferenceRecordingQueue`），在**非聚焦**状态下串行取走
 * dirty 镜头交给注入的 `recorder`。本模块**不含**具体录制/编码/上传实现——那是任务 8.4 的
 * `recorder`；本模块只保证：
 *
 * - 聚焦内只标脏、不取走；退出聚焦后再触发；
 * - 非聚焦权威内容提交、初次加载缺缓存、下游显式请求都会补排并触发；
 * - 不做聚焦内防抖：内容一变即标脏，`reconcile` 立即可被聚焦退出唤醒；
 * - 串行执行（同一时刻最多一个在录），失败可重试，队列状态可观察；
 * - **失败后有界自动重试**：进入画布时渲染器/媒体常常尚未就绪，失败不能只等下一次用户交互
 *   （旧画布因此永远缺录制数据）。重试只在仍有 dirty 时按指数退避进行，成功或外部触发后归零，
 *   次数上限缺省 5，绝不无限空转。
 *
 * 纯编排类：通过 deps 读取画布与聚焦、注入计时器，不 import DOM/Zustand/Yjs/全局定时器。
 */
import {
  ShotReferenceRecordingQueue,
  type ShotReferenceRecordingJob
} from "./shot-reference-recording-queue.js";
import { observeFilmSets, shotReferenceJobForClip, type ShotReferenceCanvasLike } from "./shot-reference-observation.js";

/** 录制结果：成功表示该版本已编码、上传并校验；失败给出可读原因，可重试。 */
export type ShotReferenceRecordResult = { ok: true } | { ok: false; error: string };

/** 录制能力（任务 8.4 提供真实实现）。 */
export type ShotReferenceRecorder = (job: ShotReferenceRecordingJob) => Promise<ShotReferenceRecordResult>;

export type ShotReferenceSchedulerDeps = {
  /** 当前画布 id；无画布返回空串（此时不排任何任务）。 */
  canvasId(): string;
  /** 权威画布快照（工作副本优先）。 */
  canvas(): ShotReferenceCanvasLike | null;
  /** 当前聚焦编辑的片场节点 id；未聚焦为 `null`。 */
  focusedFilmSetId(): string | null;
  /**
   * 录制能力。为 `null` 时不取走任务（只保留 dirty），以便只维护 dirty 集的场景保持可观察、不空转。
   */
  recorder: ShotReferenceRecorder | null;
  /**
   * 版本缓存中该内容身份是否已 ready（任务 8.5）。命中的镜头不重复录制：加载/恢复时用缓存
   * 直接标记已记录。
   */
  isCachedReady?(ref: { canvasId: string; filmSetNodeId: string; clipId: string; contentIdentity: string; profileKey: string }): boolean;
  /** 队列状态变化通知（UI/诊断）。 */
  onStateChange?(): void;
  /**
   * 安排一次自动重试（缺省不重试）。由接线层注入 `setTimeout`，测试注入假计时器。
   */
  scheduleRetry?(run: () => void, delayMs: number): ShotReferenceRetryHandle;
  /** 取消尚未触发的自动重试。 */
  cancelRetry?(handle: ShotReferenceRetryHandle): void;
  /** 同一版本最多自动重试次数（缺省 5）。 */
  maxRetries?: number;
  /** 重试退避基数与上限毫秒（缺省 2000 / 30000）。 */
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
};

/** 自动重试句柄；对调度器不透明（生产是 `setTimeout` 返回值）。 */
export type ShotReferenceRetryHandle = unknown;

export type ShotReferenceSchedulerSnapshot = {
  dirty: readonly ShotReferenceRecordingJob[];
  inflight: readonly string[];
  focused: string | null;
  busy: boolean;
  lastError: string | null;
  /** 已用掉的自动重试次数；成功或外部触发后归零。 */
  retryAttempt: number;
};

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_BASE_MS = 2_000;
const DEFAULT_RETRY_MAX_MS = 30_000;

export class ShotReferenceRecordingScheduler {
  private readonly queue = new ShotReferenceRecordingQueue();
  private pumping = false;
  private lastError: string | null = null;
  private retryAttempt = 0;
  private retryHandle: ShotReferenceRetryHandle | null = null;

  constructor(private readonly deps: ShotReferenceSchedulerDeps) {}

  /** 用当前画布与聚焦重算 dirty 集，并在允许时启动串行录制。外部触发，重置重试预算。 */
  reconcile(): void {
    this.resetRetry();
    const canvasId = this.deps.canvasId();
    if (!canvasId) {
      this.queue.observe("", []);
      this.notify();
      return;
    }
    // 先更新聚焦（可能刚退出聚焦），再观察内容；`drain` 会据此放行。
    this.queue.setFocused(this.deps.focusedFilmSetId());
    const observations = observeFilmSets(this.deps.canvas(), this.deps.focusedFilmSetId());
    // 版本缓存已就绪的同版本不重复录制（缺缓存恢复的反面：有缓存直接复用）。
    for (const filmSet of observations) {
      for (const clip of filmSet.clips) {
        if (!clip.contentIdentity) continue;
        const ref = {
          canvasId,
          filmSetNodeId: filmSet.filmSetNodeId,
          clipId: clip.clipId,
          contentIdentity: clip.contentIdentity,
          profileKey: clip.profileKey
        };
        if (this.deps.isCachedReady?.(ref)) this.queue.markRecorded(ref);
      }
    }
    this.queue.observe(canvasId, observations);
    this.notify();
    void this.pump();
  }

  /** 下游请求补排：把某镜头当前版本加入 dirty 集并触发。外部触发，重置重试预算。 */
  requestRecord(filmSetNodeId: string, clipId: string): void {
    this.resetRetry();
    const canvasId = this.deps.canvasId();
    if (!canvasId) return;
    const job = shotReferenceJobForClip(canvasId, this.deps.canvas(), filmSetNodeId, clipId);
    if (!job) return; // 非可录镜头（静态/缺失/非法）：明确不排，不猜。
    this.queue.setFocused(this.deps.focusedFilmSetId());
    this.queue.enqueue(job);
    this.notify();
    void this.pump();
  }

  /** 外部版本缓存已就绪：直接标记，不重新录制。 */
  markRecorded(job: { canvasId: string; filmSetNodeId: string; clipId: string; contentIdentity: string }): void {
    this.queue.markRecorded(job);
    this.notify();
  }

  /** 某版本是否已 ready（供下游执行准备阶段查询）。 */
  isRecorded(job: { canvasId: string; filmSetNodeId: string; clipId: string; contentIdentity: string }): boolean {
    return this.queue.isRecorded(job);
  }

  snapshot(): ShotReferenceSchedulerSnapshot {
    const state = this.queue.snapshot();
    return { dirty: state.dirty, inflight: state.inflight, focused: state.focused, busy: this.pumping, lastError: this.lastError, retryAttempt: this.retryAttempt };
  }

  /** 接线层释放：取消尚未触发的自动重试。 */
  dispose(): void {
    this.resetRetry();
  }

  /** 取消待触发的重试并归零预算（外部触发/释放时调用）。 */
  private resetRetry(): void {
    if (this.retryHandle !== null) {
      this.deps.cancelRetry?.(this.retryHandle);
      this.retryHandle = null;
    }
    this.retryAttempt = 0;
  }

  /** 失败后按指数退避安排一次重试；仍有 dirty、未超次数上限、且没有待触发重试时才排。 */
  private scheduleRetry(): void {
    const schedule = this.deps.scheduleRetry;
    if (!schedule || this.retryHandle !== null) return;
    if (this.queue.snapshot().dirty.length === 0) return;
    if (this.retryAttempt >= (this.deps.maxRetries ?? DEFAULT_MAX_RETRIES)) return;
    this.retryAttempt += 1;
    const base = this.deps.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS;
    const cap = this.deps.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_MS;
    const delay = Math.min(base * 2 ** (this.retryAttempt - 1), cap);
    this.retryHandle = schedule(() => {
      this.retryHandle = null;
      void this.pump();
    }, delay);
  }

  /** 串行泵：一次取一个 job 交给 recorder。成功继续取下一个；失败停止本轮，保留 dirty 待下次重试。 */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    const recorder = this.deps.recorder;
    if (!recorder) return;
    this.pumping = true;
    try {
      for (;;) {
        const job = this.queue.nextJob();
        if (!job) break;
        let result: ShotReferenceRecordResult;
        try {
          result = await recorder(job);
        } catch (cause) {
          result = { ok: false, error: cause instanceof Error ? cause.message : "镜头录制失败" };
        }
        if (result.ok) {
          this.queue.complete(job);
          this.lastError = null;
          this.retryAttempt = 0;
          this.notify();
          continue;
        }
        // 失败：保留 dirty，停止本轮；按退避安排有界自动重试（外部触发会归零预算）。
        this.queue.fail(job);
        this.lastError = result.error;
        this.notify();
        this.scheduleRetry();
        break;
      }
    } finally {
      this.pumping = false;
      // 结算后可能又有新 dirty；由调用方再次 reconcile。
      this.notify();
    }
  }

  private notify(): void {
    this.deps.onStateChange?.();
  }
}
