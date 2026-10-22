/**
 * Page-scoped task activity store
 * （change: 2026-09-29-add-canvas-task-activity-feed，任务 2.2 / design D2；
 *   change: formalize-frontend-event-bus，任务 4.1–4.4 / design D4、D7）。
 *
 * 纯逻辑（不依赖 React/远端实现）：这是**可重放的状态源**，不是事件日志。所有输入来自
 * 三个 `task.activity.*` 事件（由 page-scoped bridge 或 Task Execution 抛出）：
 *
 * - `started`：按 runId 插入/刷新乐观项；
 * - `updated`：按 taskKey（缺失时 runId）幂等 upsert 权威非终态项；
 * - `finished`：权威终态 upsert，或本地拒绝只结算匹配的乐观 run。
 *
 * 事件**不是**严格状态机：`updated`/`finished` 可在没有 `started` 时先到达（刷新、跨标签页、
 * 断线恢复、迟到记录）。合并优先按 `taskKey`，尚未取得 taskKey 时按 `runId` 兜底；同一任务
 * 只保留一条，且状态更新不改变首次已知提交排序（最近提交在顶部）。
 *
 * 单调 cursor 规则（design D4）：同一 taskKey 记录最大已应用 cursor，较旧 cursor 的记录不得
 * 回退已有较新状态/进度；同 cursor 重复投递为 no-op。终态项显示 10 秒后退出，动画结束再移除；重复投递不延长显示，也不会重新出现。
 *
 * dispose 后任何迟到输入都不得再改变状态（scope identity 保护）。React 只订阅 store
 * snapshot（design D7），不从事件回调直接渲染。
 */
import {
  isActiveTaskState,
  isTerminalTaskState,
  type BackgroundActivityJob,
  type CanvasTaskActivity,
  type TaskExecutionState
} from "@woohaa3/contracts";
import type {
  TaskActivityFinished,
  TaskActivityStarted,
  TaskActivityUpdated
} from "@woohaa3/contracts";
import { isLocalRejection } from "@woohaa3/contracts";
import type { CanvasGroupRun, CanvasGroupRunsSnapshot } from "@woohaa3/frontend/extension-api";

/** 展示偏好本地存储键（有界、非事实源）。 */
export const ACTIVITY_PREFERENCE_KEY = "woohaa3.task-activity.dismissed";

export type ActivityFeedItem = CanvasTaskActivity & {
  /** 本地 optimistic（服务端尚未确认）；不作为 canonical 事实。 */
  optimistic: boolean;
  /** 本地提交被拒（网关拒绝）；显示可诊断失败，不伪造 taskKey/产物。 */
  localFailure: boolean;
};

export type BackgroundFeedJob = BackgroundActivityJob & { createdAt: string };

/** 到期后保留行，供面板完成退出动画；不改变任务的领域状态。 */
export const ACTIVITY_EXIT_DURATION_MS = 200;

export type ActivityFeedSnapshot = {
  groups: readonly CanvasGroupRun[];
  groupError: string;
  selectedGroupId: string | null;
  openRevision: number;
  items: ActivityFeedItem[];
  /** 正在退出的展示记录，使用 task:<runId> / job:<id> 区分。 */
  exitingKeys: readonly string[];
  /** 扩展后台活动（非 durable 任务），按首次出现顺序；终态可由用户关闭。 */
  jobs: BackgroundFeedJob[];
  /** 未读终态数（用于折叠入口徽标）。 */
  unread: number;
  cursor: number;
  /** 是否存在任何 active 项（含后台活动）。 */
  hasActive: boolean;
};

export type ActivityStoreOptions = {
  now?: () => number;
};

/** 后台活动上限：超过时优先淘汰最旧的终态记录，避免自动录制无限累积。 */
const MAX_BACKGROUND_JOBS = 32;

function isActiveBackgroundJob(job: BackgroundActivityJob): boolean {
  return job.status === "queued" || job.status === "running";
}

export class TaskActivityStore {
  private groupRuns: readonly CanvasGroupRun[] = [];
  private groupError = "";
  private readonly dismissedGroups = new Set<string>();
  private selectedGroupId: string | null = null;
  private openRevision = 0;
  private items: ActivityFeedItem[] = [];
  private readonly jobs = new Map<string, BackgroundFeedJob>();
  private readonly jobOrder: string[] = [];
  private listeners = new Set<() => void>();
  private cursor = 0;
  private unread = 0;
  private snapshot: ActivityFeedSnapshot = { items: [], jobs: [], groups: [], groupError: "", selectedGroupId: null, openRevision: 0, exitingKeys: [], unread: 0, cursor: 0, hasActive: false };
  /**
   * 每个 taskKey 已接受的最高 cursor（change: formalize-frontend-event-bus，design D4）。
   * 用于拒绝**较旧 cursor** 的记录覆盖较新的权威状态（补偿与 live 乱序/重复）。
   */
  private readonly acceptedCursorByKey = new Map<string, number>();
  private disposed = false;
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly expired = new Set<string>();
  private readonly exiting = new Set<string>();

  constructor(private readonly options: ActivityStoreOptions = {}) {}

  getSnapshot = (): ActivityFeedSnapshot => this.snapshot;

  replaceGroupRuns(input: CanvasGroupRunsSnapshot): void {
    if (this.disposed) return;
    for (const row of input.rows) {
      const previous = this.groupRuns.find(entry => entry.creation.requestId === row.creation.requestId);
      if (row.active) this.dismissedGroups.delete(row.creation.requestId);
      if (!row.active && previous?.active) this.unread++;
    }
    this.groupRuns = input.rows;
    this.groupError = input.error;
    this.publish();
  }

  openGroup(nodeId: string): void {
    if (this.disposed) return;
    const row = this.groupRuns.find(entry => entry.creation.rootGroupId === nodeId);
    if (row) this.dismissedGroups.delete(row.creation.requestId);
    this.selectedGroupId = nodeId;
    this.openRevision++;
    this.unread = 0;
    this.publish();
  }

  dismissGroup(id: string): void {
    const row = this.groupRuns.find(entry => entry.creation.requestId === id);
    if (!row || row.active || this.disposed) return;
    this.dismissedGroups.add(id);
    this.publish();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** 统一事件入口：由 bridge/Plugin listener 调用（也便于测试与 mock）。 */
  applyEvent(
    event:
      | { name: "task.activity.started"; payload: TaskActivityStarted }
      | { name: "task.activity.updated"; payload: TaskActivityUpdated }
      | { name: "task.activity.finished"; payload: TaskActivityFinished }
  ): void {
    if (this.disposed) return;
    switch (event.name) {
      case "task.activity.started":
        this.applyStarted(event.payload);
        return;
      case "task.activity.updated":
        this.applyUpdated(event.payload);
        return;
      case "task.activity.finished":
        this.applyFinished(event.payload);
        return;
    }
  }

  /** 本地 optimistic 开始（Task Execution 生成 runId 后抛出）。 */
  applyStarted(input: TaskActivityStarted): void {
    if (this.disposed || this.expired.has(`task:${input.runId}`)) return;
    const createdAt = input.createdAt || new Date(this.options.now?.() ?? Date.now()).toISOString();
    const existing = this.items.findIndex((item) => item.runId === input.runId);
    if (existing !== -1) {
      // 已存在（重复 started）：只刷新乐观标记与元数据，不重置排序。
      this.items[existing] = {
        ...this.items[existing],
        state: "queued",
        optimistic: true,
        ...(input.modelType ? { modelType: input.modelType } : {}),
        ...(input.modelKey ? { modelKey: input.modelKey } : {})
      };
      this.publish();
      return;
    }
    this.items.push({
      taskKey: input.runId,
      runId: input.runId,
      nodeId: input.nodeId,
      state: "queued",
      ...(input.modelType ? { modelType: input.modelType } : {}),
      ...(input.modelKey ? { modelKey: input.modelKey } : {}),
      createdAt,
      updatedAt: createdAt,
      durationMs: 0,
      optimistic: true,
      localFailure: false
    });
    this.sortItems();
    this.publish();
  }

  /** 权威非终态活动。 */
  applyUpdated(input: TaskActivityUpdated): void {
    if (this.disposed) return;
    this.mergeServerItems([input.activity], input.cursor);
  }

  /** 权威终态活动或本地拒绝。 */
  applyFinished(input: TaskActivityFinished): void {
    if (this.disposed) return;
    if (isLocalRejection(input)) {
      this.applyLocalRejection(input);
      return;
    }
    this.mergeServerItems([input.activity], input.cursor);
  }

  private applyLocalRejection(input: Extract<TaskActivityFinished, { source: "local-rejection" }>): void {
    const index = this.items.findIndex((item) => item.runId === input.activity.runId && item.optimistic);
    if (index === -1) return;
    this.items[index] = {
      ...this.items[index],
      state: "failed",
      localFailure: true,
      optimistic: false,
      error: { message: input.activity.error.message }
    };
    this.onStateChanged(this.items[index]);
    this.publish();
  }

  /**
   * 合并一条权威记录（taskKey 优先、runId 兜底；单调 cursor；保持首提交排序）。
   *
   * 展示夹具/兼容桥接入口：bridge 会把它分类为 updated/finished 事件；store 自身也接受直接
   * 合并（供静态渲染 fixture 使用）。
   */
  applyServerRecord(record: CanvasTaskActivity, cursor: number): void {
    if (this.disposed) return;
    this.mergeServerItems([record], cursor);
  }

  /** 关闭单条记录（只允许终态；active 项不可删除）。 */
  dismiss(key: string): void {
    const item = this.items.find((entry) => entry.taskKey === key);
    if (!item || isActiveTaskState(item.state)) return;
    this.removeItem(key);
  }

  /**
   * 扩展后台活动：按活动 `id` 幂等 upsert（每次尝试保留一条）。
   *
   * 迟到记录用 `updatedAt` 比较拒绝回退；到达终态后仍保留，10 秒后自动移除，也可由用户关闭或上限淘汰。
   */
  applyJob(job: BackgroundActivityJob): void {
    if (this.disposed || this.expired.has(`job:${job.id}`)) return;
    const previous = this.jobs.get(job.id);
    if (previous && previous.updatedAt > job.updatedAt) return;
    if (!previous) this.jobOrder.push(job.id);
    this.jobs.set(job.id, { ...job, createdAt: previous?.createdAt ?? job.updatedAt });
    this.trimJobs();
    this.publish();
  }

  /** 关闭单条后台活动（只允许终态）。 */
  dismissJob(id: string): void {
    const job = this.jobs.get(id);
    if (!job || isActiveBackgroundJob(job)) return;
    this.removeJob(id);
    this.publish();
  }

  /** 清除全部终态记录（active 项保留）。 */
  clearTerminal(): void {
    for (const row of this.groupRuns) {
      if (!row.active) this.dismissedGroups.add(row.creation.requestId);
    }
    const survivors = this.items.filter((item) => isActiveTaskState(item.state));
    let changed = survivors.length !== this.items.length;
    this.items = survivors;
    for (const id of [...this.jobOrder]) {
      const job = this.jobs.get(id);
      if (job && !isActiveBackgroundJob(job)) {
        this.removeJob(id);
        changed = true;
      }
    }
    if (!changed && this.groupRuns.length === 0) return;
    this.publish();
  }

  /** 折叠入口展开后清零未读。 */
  markRead(): void {
    if (this.unread === 0) return;
    this.unread = 0;
    this.publish();
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    this.exiting.clear();
    this.listeners.clear();
  }

  private mergeServerItems(records: CanvasTaskActivity[], cursor: number): void {
    if (this.disposed) return;
    this.cursor = Math.max(this.cursor, cursor);
    const byKey = new Map<string, ActivityFeedItem>();
    for (const item of this.items) byKey.set(item.taskKey, item);
    const byRun = new Map<string, ActivityFeedItem>();
    for (const item of this.items) {
      if (!byRun.has(item.runId)) byRun.set(item.runId, item);
    }

    let changed = false;
    for (const record of records) {
      if (this.expired.has(`task:${record.runId}`)) continue;
      // taskKey 优先、runId 兜底。
      const existing = byKey.get(record.taskKey) ?? byRun.get(record.runId);
      // 单调 cursor：同一任务较旧 cursor 的记录不得覆盖较新的权威状态。
      const accepted = this.acceptedCursorByKey.get(record.taskKey);
      if (accepted !== undefined && cursor < accepted) continue;
      this.acceptedCursorByKey.set(record.taskKey, Math.max(accepted ?? 0, cursor));
      if (existing) {
        const index = this.items.indexOf(existing);
        const previousState = existing.state;
        const merged: ActivityFeedItem = {
          ...existing,
          ...record,
          // 保持首次提交时间与排序。
          createdAt: existing.createdAt,
          optimistic: false,
          localFailure: false
        };
        this.items[index] = merged;
        byKey.set(merged.taskKey, merged);
        byRun.set(merged.runId, merged);
        if (previousState !== merged.state) this.onStateChanged(merged);
        changed = true;
      } else {
        const created: ActivityFeedItem = { ...record, optimistic: false, localFailure: false };
        this.items.push(created);
        byKey.set(created.taskKey, created);
        byRun.set(created.runId, created);
        if (isTerminalTaskState(created.state)) this.unread += 1;
        changed = true;
      }
    }

    if (changed) {
      this.sortItems();
      this.publish();
    }
  }

  private onStateChanged(item: ActivityFeedItem): void {
    // 终态增加未读徽标；显示期限由 publish 统一管理。
    if (isTerminalTaskState(item.state)) this.unread += 1;
  }

  /** 列表按首次提交时间降序：最近提交在顶部。 */
  private sortItems(): void {
    this.items.sort((a, b) => {
      if (a.createdAt === b.createdAt) return a.taskKey < b.taskKey ? -1 : 1;
      return a.createdAt > b.createdAt ? -1 : 1;
    });
  }

  private removeItem(key: string): void {
    const index = this.items.findIndex((entry) => entry.taskKey === key);
    if (index === -1) return;
    this.items.splice(index, 1);
    this.publish();
  }

  private removeJob(id: string): void {
    if (!this.jobs.delete(id)) return;
    const index = this.jobOrder.indexOf(id);
    if (index >= 0) this.jobOrder.splice(index, 1);
  }

  /** 只淘汰终态后台活动；active 项永不因上限被丢弃。 */
  private trimJobs(): void {
    if (this.jobs.size <= MAX_BACKGROUND_JOBS) return;
    for (const id of [...this.jobOrder]) {
      if (this.jobs.size <= MAX_BACKGROUND_JOBS) break;
      const job = this.jobs.get(id);
      if (!job || isActiveBackgroundJob(job)) continue;
      this.removeJob(id);
    }
  }

  /** 从首次收到终态起计时，到期先退出再移除；重复更新不续期，dispose/手动清理撤销计时器。 */
  private syncExpiry(): void {
    const terminal = new Set([
      ...this.items.filter(item => isTerminalTaskState(item.state)).map(item => `task:${item.runId}`),
      ...[...this.jobs.values()].filter(job => !isActiveBackgroundJob(job)).map(job => `job:${job.id}`)
    ]);
    for (const [key, timer] of this.expiryTimers) {
      if (terminal.has(key)) continue;
      clearTimeout(timer);
      this.expiryTimers.delete(key);
      this.exiting.delete(key);
    }
    for (const key of terminal) {
      if (this.expiryTimers.has(key)) continue;
      this.expiryTimers.set(key, setTimeout(() => {
        if (this.disposed) return;
        this.expired.add(key);
        this.exiting.add(key);
        // 保持记录和面板挂载到动画结束；即使 CSS 动画未执行也能按时清理。
        this.expiryTimers.set(key, setTimeout(() => {
          this.expiryTimers.delete(key);
          this.exiting.delete(key);
          if (this.disposed) return;
          if (key.startsWith("task:")) {
            this.items = this.items.filter(item => `task:${item.runId}` !== key);
            this.unread = Math.max(0, this.unread - 1);
          } else {
            this.removeJob(key.slice(4));
          }
          this.publish();
        }, ACTIVITY_EXIT_DURATION_MS));
        this.publish();
      }, 10_000));
    }
  }

  private publish(): void {
    if (this.disposed) return;
    this.syncExpiry();
    const jobs = this.jobOrder.flatMap((id) => {
      const job = this.jobs.get(id);
      return job ? [job] : [];
    });
    const groups = this.groupRuns.filter(row => !this.dismissedGroups.has(row.creation.requestId));
    const hasActive = this.items.some((item) => isActiveTaskState(item.state)) || jobs.some(isActiveBackgroundJob) || groups.some(row => row.active);
    this.snapshot = {
      groups,
      groupError: this.groupError,
      selectedGroupId: this.selectedGroupId,
      openRevision: this.openRevision,
      items: [...this.items],
      jobs,
      exitingKeys: [...this.exiting],
      unread: this.unread,
      cursor: this.cursor,
      hasActive
    };
    for (const listener of this.listeners) listener();
  }
}

/** 供 bridge/测试复用的状态类型别名。 */
export type { TaskExecutionState };
