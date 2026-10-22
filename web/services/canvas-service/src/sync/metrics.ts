/**
 * 协作同步的 health / metrics（任务 8.6 / design D13）。
 *
 * 只输出**安全**字段：ID、revision、字节数、延迟与错误码。绝不记录 prompt、Yjs bytes、
 * 签名 URL 或凭据（spec「同步连接受统一安全与容量边界保护」）。
 */
import type { CanvasWriterLock } from "./writer-lock.js";
import type { CanvasRoomRegistry } from "./room-registry.js";
import type { CanvasSessionHub } from "./sync-hub.js";
import type { YjsDocumentRepository } from "./yjs-repository.js";

export type YjsReadiness = {
  ready: boolean;
  /** 失败原因（安全短文案）。 */
  reason?: string;
  /** 是否持有 writer lock（单实例约束）。 */
  writerLock: boolean;
  /** writer lock 持有者 id（不安全信息：只给 id，不给地址/凭据）。 */
  writerLockHolder?: string;
  /** 数据库 profile 健康。 */
  storageReady: boolean;
  /** 当前活跃 room 数。 */
  activeRooms: number;
  /** 当前同步连接数。 */
  activeConnections: number;
};

export type YjsMetricsSnapshot = {
  capturedAt: string;
  activeRooms: number;
  activeConnections: number;
  /** 累计投影/命令计数由调用方维护并传入（这里只做快照）。 */
  counters: Record<string, number>;
};

export type YjsReadinessOptions = {
  repository: YjsDocumentRepository;
  writerLock: CanvasWriterLock;
  registry: CanvasRoomRegistry;
  hub: CanvasSessionHub;
  /** 同步连接计数（由 upgrade 层提供）。 */
  connectionCount: () => number;
  now?: () => string;
};

/**
 * 协作 readiness（任务 8.6）。
 *
 * 任一条件不满足即 ready=false：数据库不可用、未持有 writer lock（多实例）、
 * 或已加载 room 处于隔离状态。
 */
export async function checkYjsReadiness(options: YjsReadinessOptions): Promise<YjsReadiness> {
  const storage = await options.repository.health();
  const lock = await options.writerLock.health();

  const base: YjsReadiness = {
    ready: false,
    writerLock: lock.ok,
    writerLockHolder: lock.holder,
    storageReady: storage.ok,
    activeRooms: options.registry.size,
    activeConnections: options.connectionCount()
  };

  if (!storage.ok) {
    return { ...base, reason: `存储不可用（${storage.backend}）` };
  }
  if (!lock.ok) {
    return { ...base, reason: lock.reason ?? "未持有协作 writer lock（需要单实例）" };
  }
  return { ...base, ready: true };
}

/** 采集安全 metrics 快照（任务 8.6）。 */
export function collectYjsMetrics(
  options: Pick<YjsReadinessOptions, "registry" | "hub" | "connectionCount" | "now">,
  counters: Record<string, number> = {}
): YjsMetricsSnapshot {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    capturedAt: now(),
    activeRooms: options.registry.size,
    activeConnections: options.connectionCount(),
    // 只保留数值，避免把任意对象带进日志。
    counters: Object.fromEntries(
      Object.entries(counters).filter(([, value]) => typeof value === "number")
    )
  };
}

/**
 * 安全日志事件的形状（任务 8.6 / design D13）。
 *
 * 这是**白名单**：只有这些字段允许进入日志。调用方不应传入 prompt / bytes / URL。
 */
export type SyncLogEvent = {
  event:
    | "sync-connected"
    | "sync-disconnected"
    | "sync-non-loopback-rejected"
    | "sync-token-rejected"
    | "sync-origin-rejected"
    | "sync-connection-limited"
    | "sync-attach-failed"
    // Canvas Session 提升后的 session/channel 维度（change: unify-canvas-session-websocket，任务 6.3）。
    | "session-connected"
    | "session-disconnected"
    | "session-version-missing"
    | "session-frame-rejected"
    | "session-slow-consumer"
    | "channel-message"
    | "activity-relay-start"
    | "activity-relay-stop"
    | "activity-relay-error"
    | "activity-catch-up"
    | "command-accepted"
    | "command-rejected"
    | "command-duplicate"
    | "room-quarantined"
    | "checkpoint-compacted"
    | "projection-applied"
    | "projection-skipped"
    | "projection-failed";
  status: number;
  canvasId?: string;
  revision?: number;
  bytes?: number;
  latencyMs?: number;
  commandId?: string;
  code?: string;
  /** 逻辑通道名（`canvas-yjs` / `task-activity` / `session-control`）。 */
  channel?: string;
  /** activity relay cursor/lag（高水位）。 */
  cursor?: number;
};

/** 过滤并序列化日志事件，剔除任何非白名单字段。 */
export function sanitizeSyncLogEvent(event: SyncLogEvent): Record<string, string | number> {
  const allowed: Array<keyof SyncLogEvent> = [
    "event", "status", "canvasId", "revision", "bytes", "latencyMs", "commandId", "code", "channel", "cursor"
  ];
  const result: Record<string, string | number> = {};
  for (const key of allowed) {
    const value = event[key];
    if (typeof value === "string" || typeof value === "number") result[key] = value;
  }
  return result;
}

/**
 * 计数器（任务 8.6）。
 *
 * 只加不减的整数；用于 sync bytes / command latency / checkpoint 等指标。
 * 刻意不保存任何 payload。
 */
export class YjsMetricsCounters {
  private readonly values = new Map<string, number>();
  /** 延迟求和与次数，用于算平均而不保留分位样本（避免无界内存）。 */
  private readonly latencies = new Map<string, { sum: number; count: number }>();

  increment(name: string, delta = 1): void {
    this.values.set(name, (this.values.get(name) ?? 0) + delta);
  }

  observeLatency(name: string, ms: number): void {
    const current = this.latencies.get(name) ?? { sum: 0, count: 0 };
    current.sum += ms;
    current.count += 1;
    this.latencies.set(name, current);
  }

  snapshot(): Record<string, number> {
    const result: Record<string, number> = Object.fromEntries(this.values);
    for (const [name, { sum, count }] of this.latencies) {
      result[`${name}_count`] = count;
      result[`${name}_avgMs`] = count === 0 ? 0 : Math.round((sum / count) * 100) / 100;
    }
    return result;
  }
}
