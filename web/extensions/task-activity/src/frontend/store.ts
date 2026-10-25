/**
 * Page-scoped task activity store
 * （change: 2026-09-29-add-canvas-task-activity-feed，任务 2.2 / design D2；
 *   change: formalize-frontend-event-bus，任务 4.1–4.4 / design D4、D7；
 *   change: 2026-10-22-unify-task-activity-rows，任务 1.3 / 2.1–2.4 / 4.1：
 *   **单一记录模型**——面板的寿命、排序、关闭、清除、未读与自动收起都只面向 `rows`，
 *   三种来源各自一个纯适配器接入，不再按记录种类分叉。）。
 *
 * 纯逻辑（不依赖 React/远端实现）：这是**可重放的状态源**，不是事件日志。输入有四类：
 *
 * - `task.activity.*` 事件（由 page-scoped bridge 或 Task Execution 抛出）：
 *   `started` 按 runId 插入/刷新乐观项，`updated`/`finished` 按 taskKey（缺失时 runId）
 *   幂等 upsert 权威记录；
 * - `extension.activity.updated` 的 `applyJob`（扩展后台活动，按活动 id 幂等）；
 * - 宿主 `canvasGroupRuns` 轮询的 `replaceGroupRuns`（整表替换）；
 * - 用户显式动作（关闭、清除、从组节点重开）。
 *
 * 事件**不是**严格状态机：`updated`/`finished` 可在没有 `started` 时先到达（刷新、跨标签页、
 * 断线恢复、迟到记录）。同一任务只保留一条，且状态更新不改变首次已知提交排序（最近提交在顶部）。
 *
 * 单调 cursor 规则（design D4）：同一 taskKey 记录最大已应用 cursor，较旧 cursor 的记录不得
 * 回退已有较新状态/进度；同 cursor 重复投递为 no-op。
 *
 * 寿命规则只有一条（change: 2026-10-22-unify-task-activity-rows，design D2）：任何来源的记录
 * 首次观察到终态后停留 `ACTIVITY_TERMINAL_LINGER_MS`，随后标记退出、`ACTIVITY_EXIT_DURATION_MS`
 * 后移除。判定只看 `ActivityRow.active`，不再有 `task:` / `job:` 前缀分支。移除后的「不复活」
 * 分工见 `rows.ts`：任务/后台活动写 `expired`，组记录写 `dismissedGroups`。
 *
 * dispose 后任何迟到输入都不得再改变状态（scope identity 保护）。React 只订阅 store
 * snapshot（design D7），不从事件回调直接渲染。
 */
import {
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
import type { CanvasGroupRun, CanvasGroupRunsSnapshot, TaskActivityRow } from "@woohaa3/frontend/extension-api";
import { adaptGroupRow } from "./adapt-group-row.js";
import { adaptJobRow, isActiveBackgroundJob } from "./adapt-job-row.js";
import { adaptTaskRow } from "./adapt-task-row.js";
import {
  compareRows,
  type ActivityRow,
  type ActivityRowCapabilities
} from "./rows.js";

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

/** 终态记录的统一下滑/淡出时长（任何来源一致）。 */
export const ACTIVITY_TERMINAL_LINGER_MS = 10_000;

export type ActivityFeedSnapshot = {
  /** 唯一记录列表：全部来源按开始时间从新到旧交错。 */
  rows: readonly ActivityRow[];
  /**
   * 组创作读模型的可见子集（等价于 `rows` 里的 group 记录）。
   * 过渡字段，仅为兼容既有读法保留。
   */
  groups: readonly CanvasGroupRun[];
  groupError: string;
  selectedGroupId: string | null;
  openRevision: number;
  /** 过渡字段：由 `rows` 中的 task 记录派生。 */
  items: ActivityFeedItem[];
  /** 正在退出的展示记录，使用 `ActivityRow.key`。 */
  exitingKeys: readonly string[];
  /** 过渡字段：由 `rows` 中的 job 记录派生。 */
  jobs: BackgroundFeedJob[];
  /** 未读终态数（用于折叠入口徽标）。 */
  unread: number;
  cursor: number;
  /** 是否存在任何 active 记录。 */
  hasActive: boolean;
};

export type ActivityStoreOptions = {
  now?: () => number;
  /** 行适配能力（定位、详情、组动作）；由插件装配时构造一次（design D6）。 */
  capabilities?: ActivityRowCapabilities;
};

/** 后台活动上限：超过时优先淘汰最旧的终态记录，避免自动录制无限累积。 */
const MAX_BACKGROUND_JOBS = 32;

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
  private rows: ActivityRow[] = [];
  private capabilities: ActivityRowCapabilities = {};
  private snapshot: ActivityFeedSnapshot = {
    rows: [],
    items: [],
    jobs: [],
    groups: [],
    groupError: "",
    selectedGroupId: null,
    openRevision: 0,
    exitingKeys: [],
    unread: 0,
    cursor: 0,
    hasActive: false
  };
  /**
   * 每个 taskKey 已接受的最高 cursor（change: formalize-frontend-event-bus，design D4）。
   * 用于拒绝**较旧 cursor** 的记录覆盖较新的权威状态（补偿与 live 乱序/重复）。
   */
  private readonly acceptedCursorByKey = new Map<string, number>();
  private disposed = false;
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 已移除、不得因重放复活的记录键（任务 / 后台活动）。组记录用 `dismissedGroups`。 */
  private readonly expired = new Set<string>();
  private readonly exiting = new Set<string>();

  constructor(private readonly options: ActivityStoreOptions = {}) {
    if (options.capabilities) this.capabilities = options.capabilities;
  }

  /**
   * 装配期注入行适配能力。插件在构造 store 之后、注册浮层之前调用一次；
   * 之后到达的记录都按同一份能力生成，渲染层不需要按来源分支取 props（design D6）。
   */
  configure(capabilities: ActivityRowCapabilities): void {
    if (this.disposed) return;
    this.capabilities = capabilities;
    this.publish();
  }

  getSnapshot = (): ActivityFeedSnapshot => this.snapshot;

  replaceGroupRuns(input: CanvasGroupRunsSnapshot): void {
    if (this.disposed) return;
    for (const row of input.rows) {
      const previous = this.groupRuns.find(entry => entry.requestId === row.requestId);
      // 组记录重新 active（用户重开 / 同组再次执行）视为新活动：清除移除标记并重新计时。
      if (row.active) this.dismissedGroups.delete(row.requestId);
      // 与任务一致：首次观察到该组进入终态时记未读，重复终态不重复计数。
      if (!row.active && (!previous || previous.active)) this.unread++;
    }
    this.groupRuns = input.rows;
    this.groupError = input.error;
    this.publish();
  }

  /** 组节点入口：重开已移除的组记录并按新的终态观察重新计时。 */
  openGroup(nodeId: string): void {
    if (this.disposed) return;
    const row = this.groupRuns.find(entry => entry.rootGroupId === nodeId);
    if (row) {
      const key = `group:${row.requestId}`;
      this.dismissedGroups.delete(row.requestId);
      // 重开是用户显式动作：撤销可能仍在进行的退出计时，让记录按新的终态观察重新计时。
      this.exiting.delete(key);
      const timer = this.expiryTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        this.expiryTimers.delete(key);
      }
    }
    this.selectedGroupId = nodeId;
    this.openRevision++;
    this.unread = 0;
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

  /**
   * 关闭单条记录（只允许终态；active 项不可删除）。
   *
   * 统一入口：按 `ActivityRow.key` 定位，按来源分派移除与「不复活」标记。
   */
  dismissRow(key: string): void {
    if (this.disposed) return;
    const row = this.rows.find((entry) => entry.key === key);
    if (!row || row.active) return;
    this.removeRow(row);
    this.publish();
  }

  /**
   * @deprecated 使用 `dismissRow(key)`；保留薄委托以缩小调用面改动。
   *
   * 旧签名接收 taskKey，而记录键是 `task:<runId>`，因此先按 taskKey/runId 解析出 runId。
   */
  dismiss(key: string): void {
    if (key.startsWith("task:") || key.startsWith("job:") || key.startsWith("group:")) {
      this.dismissRow(key);
      return;
    }
    const item = this.items.find((entry) => entry.taskKey === key) ?? this.items.find((entry) => entry.runId === key);
    if (!item) return;
    this.dismissRow(`task:${item.runId}`);
  }

  /**
   * 扩展后台活动：按活动 `id` 幂等 upsert（每次尝试保留一条）。
   *
   * 迟到记录用 `updatedAt` 比较拒绝回退；到达终态后仍保留，统一停留时长后自动移除，
   * 也可由用户关闭或上限淘汰。
   */
  applyJob(job: BackgroundActivityJob): void {
    if (this.disposed || this.expired.has(`job:${job.id}`)) return;
    const previous = this.jobs.get(job.id);
    if (previous && previous.updatedAt > job.updatedAt) return;
    if (!previous) this.jobOrder.push(job.id);
    const wasActive = previous ? isActiveBackgroundJob(previous) : undefined;
    const next: BackgroundFeedJob = { ...job, createdAt: previous?.createdAt ?? job.updatedAt };
    this.jobs.set(job.id, next);
    // 与任务/组一致：首次观察到终态时记未读（新记录直接以终态到达也算一次）。
    if (!isActiveBackgroundJob(next) && (wasActive === undefined || wasActive)) this.unread += 1;
    this.trimJobs();
    this.publish();
  }

  /** @deprecated 使用 `dismissRow(job:<id>)`；保留薄委托以缩小调用面改动。 */
  dismissJob(id: string): void {
    this.dismissRow(id.startsWith("job:") ? id : `job:${id}`);
  }

  /** @deprecated 使用 `dismissRow(group:<requestId>)`；保留薄委托以缩小调用面改动。 */
  dismissGroup(id: string): void {
    this.dismissRow(id.startsWith("group:") ? id : `group:${id}`);
  }

  /** 清除全部终态记录（active 项保留）。三种来源遵循同一规则。 */
  clearTerminal(): void {
    if (this.disposed) return;
    const terminal = this.rows.filter((row) => !row.active);
    if (terminal.length === 0) return;
    for (const row of terminal) this.removeRow(row);
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

  /**
   * 公开只读投影：去掉来源载荷与动作函数，只保留面板渲染一致的行视图
   * （change: 2026-10-22-unify-task-activity-rows，任务 4.1 / design D5）。
   */
  getPublicSnapshot = (): {
    rows: readonly TaskActivityRow[];
    items: ActivityFeedItem[];
    jobs: BackgroundFeedJob[];
    unread: number;
    cursor: number;
    hasActive: boolean;
  } => ({
    rows: this.snapshot.rows.map(toPublicRow),
    items: this.snapshot.items,
    jobs: this.snapshot.jobs,
    unread: this.snapshot.unread,
    cursor: this.snapshot.cursor,
    hasActive: this.snapshot.hasActive
  });

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

    if (changed) this.publish();
  }

  private onStateChanged(item: ActivityFeedItem): void {
    // 终态增加未读徽标；显示期限由 publish 统一管理。
    if (isTerminalTaskState(item.state)) this.unread += 1;
  }

  /** 由三条来源集合投影出唯一记录列表（排序只在这里发生一次）。 */
  private projectRows(): ActivityRow[] {
    const rows: ActivityRow[] = [];
    for (const item of this.items) rows.push(adaptTaskRow(item, this.capabilities));
    for (const id of this.jobOrder) {
      const job = this.jobs.get(id);
      if (job) rows.push(adaptJobRow(job, this.capabilities));
    }
    for (const run of this.groupRuns) {
      if (this.dismissedGroups.has(run.requestId)) continue;
      rows.push(adaptGroupRow(run, this.capabilities, {
        selected: this.selectedGroupId === run.rootGroupId
      }));
    }
    rows.sort(compareRows);
    return rows;
  }

  /** 移除一条记录：按来源清理集合，并写入各自的「不复活」标记。 */
  private removeRow(row: ActivityRow): void {
    switch (row.source.kind) {
      case "task":
        this.expired.add(row.key);
        this.items = this.items.filter((item) => `task:${item.runId}` !== row.key);
        break;
      case "job":
        this.expired.add(row.key);
        this.removeJob(row.source.job.id);
        break;
      case "group":
        // 组来源是整表轮询：标记 dismiss，`replaceGroupRuns` 在重新 active 时清除。
        this.dismissedGroups.add(row.source.run.requestId);
        break;
    }
    // 未读只统计仍留在面板里的终态记录；移除即回退（任务 / 后台活动 / 组一致）。
    if (!row.active) this.unread = Math.max(0, this.unread - 1);
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

  /**
   * 终态显示期限：遍历 `rows`，只按 `active === false` 计时（design D2）。
   *
   * 从首次观察到终态起计时，到期先退出再移除；重复更新不续期，dispose/手动清理撤销计时器。
   */
  private syncExpiry(rows: readonly ActivityRow[]): void {
    const terminal = new Set(rows.filter((row) => !row.active).map((row) => row.key));
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
        // 任务 / 后台活动：退出期间即标记移除，事件重放不得让它复活。组记录的来源是整表轮询，
        // 由 `dismissedGroups` 承担同一职责（`replaceGroupRuns` 重新 active 时清除）。
        if (!key.startsWith("group:")) this.expired.add(key);
        this.exiting.add(key);
        // 保持记录和面板挂载到动画结束；即使 CSS 动画未执行也能按时清理。
        this.expiryTimers.set(key, setTimeout(() => {
          this.expiryTimers.delete(key);
          this.exiting.delete(key);
          if (this.disposed) return;
          const row = this.rows.find((entry) => entry.key === key);
          if (row) this.removeRow(row);
          this.publish();
        }, ACTIVITY_EXIT_DURATION_MS));
        this.publish();
      }, ACTIVITY_TERMINAL_LINGER_MS));
    }
  }

  private publish(): void {
    if (this.disposed) return;
    const rows = this.projectRows();
    this.rows = rows;
    this.syncExpiry(rows);
    const items = rows.flatMap((row) => (row.source.kind === "task" ? [row.source.item] : []));
    const jobs = rows.flatMap((row) => (row.source.kind === "job" ? [row.source.job] : []));
    const groups = rows.flatMap((row) => (row.source.kind === "group" ? [row.source.run] : []));
    this.snapshot = {
      rows,
      groups,
      groupError: this.groupError,
      selectedGroupId: this.selectedGroupId,
      openRevision: this.openRevision,
      items,
      jobs,
      exitingKeys: [...this.exiting],
      unread: this.unread,
      cursor: this.cursor,
      hasActive: rows.some((row) => row.active)
    };
    for (const listener of this.listeners) listener();
  }
}

/** 公开只读行视图类型（定义在公开契约 `extension-api/context-api.ts`）。 */
export type { TaskActivityRow } from "@woohaa3/frontend/extension-api";

/** 把内部记录投影为公开只读行：不含来源载荷与动作函数（design D5）。 */
function toPublicRow(row: ActivityRow): TaskActivityRow {
  return {
    key: row.key,
    kind: row.kind,
    title: row.title,
    ...(row.secondary !== undefined ? { secondary: row.secondary } : {}),
    ...(row.detail !== undefined ? { detail: row.detail } : {}),
    status: row.status,
    state: row.state,
    tone: row.tone,
    ...(row.progress !== undefined ? { progress: row.progress } : {}),
    ...(row.nodeId !== undefined ? { nodeId: row.nodeId } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    active: row.active
  };
}

/** 供 bridge/测试复用的状态类型别名。 */
export type { TaskExecutionState };
