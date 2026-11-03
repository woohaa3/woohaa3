/**
 * 安装任务模型（change: 2026-10-21-add-extension-marketplace-point，tasks 5.1）。
 *
 * - 每个任务有 jobId、阶段、进度与可选去重键；同一去重键在进行中时返回同一任务（D6 幂等）。
 * - 提交阶段（commit / reload / 回滚 / 卸载的指针写入）经串行队列执行：installations.json 只有一个写入者，
 *   同一时刻只有一个提交在跑；下载、校验等准备工作可以并发。
 * - 只保留最近 `retain` 条已结束任务，供设置面恢复进度。
 */
import { randomUUID } from "node:crypto";
import type {
  ExtensionInstallFailure,
  ExtensionInstallJobView,
  ExtensionInstallOutcome
} from "@woohaa3/contracts";
import { ExtensionManagerError } from "./errors.js";

export type JobAction = ExtensionInstallJobView["action"];

export type Job = {
  readonly id: string;
  readonly action: JobAction;
  readonly sourceId: string;
  readonly dedupeKey: string | null;
  readonly controller: AbortController;
  view: ExtensionInstallJobView;
  /** 任务结束（成功、失败或取消）时 resolve。 */
  readonly done: Promise<ExtensionInstallJobView>;
  /** 进入提交阶段后不可取消。 */
  committing: boolean;
  /** 用户已在弹窗里确认安装未验证的包。 */
  acceptUntrusted?: boolean;
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export type JobBoard = {
  create(input: { action: JobAction; sourceId: string; dedupeKey?: string | null; extensionId?: string; version?: string }): { job: Job; existing: boolean };
  get(jobId: string): Job | undefined;
  list(): ExtensionInstallJobView[];
  update(job: Job, patch: Partial<Pick<ExtensionInstallJobView, "phase" | "progress" | "extensionId" | "version">>): void;
  succeed(job: Job, outcome: ExtensionInstallOutcome): void;
  fail(job: Job, failure: ExtensionInstallFailure): void;
  cancel(jobId: string): ExtensionInstallJobView | null;
  /** 串行提交队列：同一时刻只有一个提交。 */
  serial<T>(task: () => Promise<T>): Promise<T>;
  /** 是否有进行中的任务（给关闭流程用）。 */
  running(): number;
};

export function createJobBoard(options: { now?: () => Date; retain?: number; idFactory?: () => string } = {}): JobBoard {
  const now = options.now ?? (() => new Date());
  const retain = options.retain ?? 20;
  const newId = options.idFactory ?? (() => randomUUID());
  const jobs = new Map<string, Job>();
  const resolvers = new Map<string, (view: ExtensionInstallJobView) => void>();
  const byDedupe = new Map<string, string>();
  let queue: Promise<unknown> = Promise.resolve();

  const prune = () => {
    const finished = [...jobs.values()].filter((job) => job.view.status !== "running");
    const excess = finished.length - retain;
    for (const job of finished.slice(0, Math.max(0, excess))) jobs.delete(job.id);
  };
  const finish = (job: Job, patch: Partial<Mutable<ExtensionInstallJobView>>) => {
    if (job.view.status !== "running") return;
    job.view = { ...job.view, ...patch, finishedAt: now().toISOString() } as ExtensionInstallJobView;
    if (job.dedupeKey && byDedupe.get(job.dedupeKey) === job.id) byDedupe.delete(job.dedupeKey);
    resolvers.get(job.id)?.(job.view);
    resolvers.delete(job.id);
    prune();
  };

  return {
    create(input) {
      const dedupeKey = input.dedupeKey ?? null;
      if (dedupeKey) {
        const existingId = byDedupe.get(dedupeKey);
        const existing = existingId ? jobs.get(existingId) : undefined;
        if (existing && existing.view.status === "running") return { job: existing, existing: true };
      }
      const id = newId();
      let resolve!: (view: ExtensionInstallJobView) => void;
      const done = new Promise<ExtensionInstallJobView>((r) => (resolve = r));
      const job: Job = {
        id,
        action: input.action,
        sourceId: input.sourceId,
        dedupeKey,
        controller: new AbortController(),
        done,
        committing: false,
        view: {
          jobId: id,
          action: input.action,
          sourceId: input.sourceId,
          ...(input.extensionId ? { extensionId: input.extensionId } : {}),
          ...(input.version ? { version: input.version } : {}),
          status: "running",
          phase: "queued",
          startedAt: now().toISOString()
        }
      };
      jobs.set(id, job);
      resolvers.set(id, resolve);
      if (dedupeKey) byDedupe.set(dedupeKey, id);
      return { job, existing: false };
    },
    get: (jobId) => jobs.get(jobId),
    list: () => [...jobs.values()].map((job) => job.view),
    update(job, patch) {
      if (job.view.status !== "running") return;
      const next = { ...job.view, ...patch } as Mutable<ExtensionInstallJobView>;
      if (patch.phase && patch.phase !== job.view.phase && patch.progress === undefined) delete next.progress;
      job.view = next;
    },
    succeed: (job, outcome) => finish(job, { status: "succeeded", outcome }),
    fail: (job, failure) => finish(job, { status: "failed", failure }),
    cancel(jobId) {
      const job = jobs.get(jobId);
      if (!job) return null;
      if (job.view.status !== "running" || job.committing) return job.view;
      job.controller.abort(new ExtensionManagerError("MARKETPLACE_CANCELLED", "安装已取消"));
      finish(job, { status: "cancelled", failure: { code: "MARKETPLACE_CANCELLED", message: "安装已取消" } });
      return job.view;
    },
    serial(task) {
      const next = queue.then(task, task);
      queue = next.catch(() => undefined);
      return next;
    },
    running: () => [...jobs.values()].filter((job) => job.view.status === "running").length
  };
}
