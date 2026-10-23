/**
 * 镜头参考录制的**后台活动投影**（任务活动浮层）
 * （change: 2026-10-15-add-film-set-shooting-shot-previews）。
 *
 * 录制是扩展拥有的后台工作，不是 durable 任务：不写任务历史、没有 runId、不调用 Provider。
 * 本模块只把录制生命周期投影成 `BackgroundActivityJob`，由调用方通过
 * `extension.activity.updated` 事件发布，`task-activity` 浮层按画布展示。
 *
 * 关键规则：
 * - **每次尝试一条记录**：排队与录制共用记录，重试新增记录并保留旧结果；
 * - **进度节流**：按 5% 分桶，避免逐帧触发 React 更新；
 * - **失败保留原因**：调度器退避重试期间保持 `failed`，真正重录时新增 `running` 记录；
 * - **不留下永久排队**：dirty 集已移除且未在录的排队项标为 `cancelled`（镜头删除/版本失效）。
 *
 * 纯类：不 import DOM/Zustand/画布，可在 node 环境直接单测。
 */
import type { BackgroundActivityJob } from "@woohaa3/contracts";
import type { ShotReferenceRecordingJob } from "./shot-reference-recording-queue.js";

export type ShotReferenceActivityDeps = {
  /** 主行标题（调用方从画布解析片场/镜头名；缺失回退「镜头参考」）。 */
  titleOf(job: ShotReferenceRecordingJob): string;
  /** 发布一条 upsert 记录。 */
  emit(job: BackgroundActivityJob): void;
};

/** 进度分桶数：20 桶 = 5% 粒度。 */
const PROGRESS_BUCKETS = 20;

export class ShotReferenceActivity {
  private readonly jobs = new Map<string, BackgroundActivityJob>();
  private readonly current = new Map<string, string>();
  private readonly identities = new Map<string, string>();
  private readonly buckets = new Map<string, number>();
  private readonly running = new Set<string>();

  constructor(
    private readonly deps: ShotReferenceActivityDeps,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  /** 稳定目标键；每次录制尝试另有独立活动 id。 */
  static id(job: { canvasId: string; filmSetNodeId: string; clipId: string }): string {
    return `shot-reference:${job.canvasId}:${job.filmSetNodeId}:${job.clipId}`;
  }

  /** 诊断/测试快照（按首次出现顺序）。 */
  records(): readonly BackgroundActivityJob[] {
    return [...this.jobs.values()];
  }

  /** 开始录制：进入 `running` 并清零进度。 */
  start(job: ShotReferenceRecordingJob): void {
    const key = ShotReferenceActivity.id(job);
    const previous = this.jobs.get(this.current.get(key) ?? "");
    if (!previous || previous.status !== "queued" || this.identities.get(previous.id) !== job.contentIdentity) {
      this.current.set(key, `${key}:${crypto.randomUUID()}`);
    }
    const id = this.current.get(key)!;
    this.running.add(id);
    this.identities.set(id, job.contentIdentity);
    this.buckets.set(id, 0);
    this.publish(job, "running", { progress: 0 });
  }

  /** 录制进度（0..total）；同一 5% 桶内不重复发布。 */
  progress(job: ShotReferenceRecordingJob, completed: number, total: number): void {
    if (!(total > 0)) return;
    const ratio = Math.max(0, Math.min(1, completed / total));
    const id = this.current.get(ShotReferenceActivity.id(job));
    if (!id || !this.running.has(id)) return;
    const bucket = Math.floor(ratio * PROGRESS_BUCKETS);
    if (this.buckets.get(id) === bucket) return;
    this.buckets.set(id, bucket);
    this.publish(job, "running", { progress: ratio });
  }

  /** 录制结束：成功 `succeeded`（进度 100%），失败保留原因并等待调度器重试。 */
  finish(job: ShotReferenceRecordingJob, result: { ok: boolean; error?: string }): void {
    const id = this.current.get(ShotReferenceActivity.id(job));
    if (!id || !this.running.delete(id)) return;
    if (result.ok) this.publish(job, "succeeded", { progress: 1 });
    else this.publish(job, "failed", { detail: result.error ?? "镜头录制失败" });
  }

  /**
   * 把调度器的 dirty 集投影成 `queued`，并把已不在 dirty、也并非在录的旧排队项标为
   * `cancelled`。失败项在内容身份未变时保留失败态（退避重试前不闪烁）。
   */
  syncQueued(dirty: readonly ShotReferenceRecordingJob[]): void {
    const dirtyIds = new Set<string>();
    for (const job of dirty) {
      const key = ShotReferenceActivity.id(job);
      let id = this.current.get(key);

      if (id && this.running.has(id)) { dirtyIds.add(id); continue; }
      const previous = id ? this.jobs.get(id) : undefined;
      if (previous?.status === "failed" && this.identities.get(id!) === job.contentIdentity) continue;
      if (!previous || previous.status !== "queued" || this.identities.get(id!) !== job.contentIdentity) {
        id = `${key}:${crypto.randomUUID()}`;
        this.current.set(key, id);
      }
      dirtyIds.add(id!);
      this.identities.set(id!, job.contentIdentity);
      this.publish(job, "queued");
    }
    for (const record of [...this.jobs.values()]) {
      if ((record.status !== "queued" && record.status !== "running") || dirtyIds.has(record.id)) continue;
      this.running.delete(record.id);
      const next: BackgroundActivityJob = { ...record, status: "cancelled", updatedAt: this.now() };
      this.jobs.set(next.id, next);
      this.deps.emit(next);
    }
  }

  private publish(
    job: ShotReferenceRecordingJob,
    status: BackgroundActivityJob["status"],
    extra: { progress?: number; detail?: string } = {}
  ): void {
    const id = this.current.get(ShotReferenceActivity.id(job))!;
    const record: BackgroundActivityJob = {
      id,
      canvasId: job.canvasId,
      kind: "shot-reference-recording",
      title: this.deps.titleOf(job) || "镜头参考",
      status,
      ...(extra.progress !== undefined ? { progress: extra.progress } : {}),
      ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
      nodeId: job.filmSetNodeId,
      updatedAt: this.now()
    };
    const previous = this.jobs.get(id);
    if (
      previous
      && previous.status === record.status
      && previous.progress === record.progress
      && previous.detail === record.detail
    ) return;
    this.jobs.set(id, record);
    this.deps.emit(record);
  }
}
