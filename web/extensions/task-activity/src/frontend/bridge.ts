/**
 * Task Activity Event Bridge
 * （change: formalize-frontend-event-bus，任务 5.1 / design D5、D8）。
 *
 * page-scoped bridge：把 Canvas Session 的 `task-activity` 逻辑通道、有限 HTTP recovery 与
 * 冷启动 snapshot 分类成 `task.activity.updated`/`task.activity.finished`，并通过**具名 typed
 * sink**交给 Plugin。Plugin 在自己的源码里用字面量 `ctx.emit(...)` 抛出（架构审计要求生产
 * emit 使用目录字面量）。
 *
 * - 只对**已验证**的 `CanvasTaskActivity` 分类（malformed 记录在 emit 前拒绝）；
 * - snapshot 只建立进入页面时的 cursor 基线，不发布已有活动；
 * - session/recovery 记录可为 active 或 terminal → `updated`/`finished`；
 * - 不拥有 UI 状态；不持有 WebSocket（物理连接由 page-owned Canvas Session 负责）。
 *
 * 启动顺序由 Plugin 保证：先注册 listener，再启动 bridge——同步 fake snapshot 的结果不会早于
 * consumer 丢失。dispose 时先停止 bridge，再移除 listener。
 */
import { isCanvasTaskActivity, type CanvasTaskActivity } from "@woohaa3/contracts";
import { classifyTaskActivity } from "@woohaa3/contracts";
import type { TaskActivityFinishedRemote, TaskActivityUpdated } from "@woohaa3/contracts";

/** bridge 的具名 typed 事件出口（Plugin 接到 `ctx.emit` 的目录字面量）。 */
export type TaskActivityBridgeSink = {
  updated(payload: TaskActivityUpdated): void;
  finished(payload: TaskActivityFinishedRemote): void;
};

export type TaskActivitySources = {
  /** 只读取进入页面时的高水位，不把已有活动填入浮层。 */
  readSnapshot: () => Promise<{ cursor: number }>;
  /** 有限增量补偿：可为 active 或 terminal。 */
  readChanges?: (after: number) => Promise<{ items: CanvasTaskActivity[]; cursor: number }>;
  /** 订阅 session `task-activity` 通道（返回 unsubscribe）。 */
  subscribe: (input: {
    cursor: number;
    onRecord: (record: CanvasTaskActivity, cursor: number) => void;
    onError?: (error: unknown) => void;
  }) => () => void;
};

export type TaskActivityBridgeOptions = {
  sink: TaskActivityBridgeSink;
  sources: TaskActivitySources;
  /** 启动后用于订阅的初始 cursor（缺省 0）。 */
  initialCursor?: number;
  /** 每次收到记录后回调当前 cursor。 */
  onCursor?: (cursor: number) => void;
  onError?: (error: unknown) => void;
  logger?: (event: { event: string; code?: string }) => void;
};

export type TaskActivityEventBridge = {
  /** 启动：只取 snapshot 高水位，然后订阅后续活动。 */
  start(): Promise<void>;
  /** 停止：退订通道并阻止迟到回调。 */
  stop(): void;
};

export function createTaskActivityEventBridge(options: TaskActivityBridgeOptions): TaskActivityEventBridge {
  let stopped = false;
  let cursor = options.initialCursor ?? 0;
  let unsubscribe: (() => void) | null = null;

  const dispatch = (record: CanvasTaskActivity, source: "snapshot" | "live" | "recovery", at: number): void => {
    // bridge 在 emit 前拒绝非法数据（spec「payload 安全边界」）。
    if (!isCanvasTaskActivity(record)) {
      options.logger?.({ event: "activity-bridge-rejected", code: "malformed-record" });
      return;
    }
    const event = classifyTaskActivity(record, source, at);
    cursor = Math.max(cursor, at);
    options.onCursor?.(cursor);
    if (event.name === "task.activity.updated") options.sink.updated(event.payload);
    else options.sink.finished(event.payload);
  };

  const compensate = async (): Promise<void> => {
    if (stopped || !options.sources.readChanges) return;
    try {
      const batch = await options.sources.readChanges(cursor);
      if (stopped) return;
      for (const record of batch.items) dispatch(record, "recovery", batch.cursor);
    } catch (error) {
      options.onError?.(error);
    }
  };

  return {
    async start() {
      if (stopped) return;
      try {
        const baseline = await options.sources.readSnapshot();
        if (stopped) return;
        cursor = Math.max(cursor, baseline.cursor);
        options.onCursor?.(cursor);
      } catch (error) {
        options.onError?.(error);
        return; // 没有可信高水位时不从零订阅，避免重放历史。
      }
      if (stopped) return;
      unsubscribe = options.sources.subscribe({
        cursor,
        onRecord: (record, at) => {
          if (stopped) return;
          dispatch(record, "live", at);
        },
        onError: (error) => {
          if (stopped) return;
          options.onError?.(error);
          void compensate();
        }
      });
    },
    stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
    }
  };
}
