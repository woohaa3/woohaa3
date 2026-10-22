/**
 * 协作 readiness / metrics / 日志脱敏测试（任务 8.6）。
 *
 * 覆盖：readiness 依赖 writer lock 与存储、metrics 只含安全数值、日志白名单过滤。
 */
import { describe, expect, it } from "vitest";
import { InMemoryYjsDocumentRepository } from "./in-memory-yjs-repository.js";
import { CanvasRoomRegistry } from "./room-registry.js";
import { CanvasSessionHub } from "./sync-hub.js";
import { InMemoryWriterLock } from "./writer-lock.js";
import { YjsMetricsCounters,
  checkYjsReadiness,
  collectYjsMetrics,
  sanitizeSyncLogEvent } from "./metrics.js";

const NOW = "2026-09-23T00:00:00.000Z";

function setup() {
  const repository = new InMemoryYjsDocumentRepository();
  const writerLock = new InMemoryWriterLock();
  const hub = new CanvasSessionHub();
  const registry = new CanvasRoomRegistry({ repository, now: () => NOW, idleTtlMs: 0 });
  let connections = 0;
  return {
    repository,
    writerLock,
    registry,
    hub,
    options: {
      repository,
      writerLock,
      registry,
      hub,
      connectionCount: () => connections,
      now: () => NOW
    },
    setConnections: (value: number) => { connections = value; }
  };
}

describe("协作 readiness（任务 8.6）", () => {
  it("存储与 writer lock 都就绪时 ready", async () => {
    const s = setup();
    await s.writerLock.acquire("instance-a", NOW);
    const result = await checkYjsReadiness(s.options);
    expect(result.ready).toBe(true);
    expect(result.writerLock).toBe(true);
    expect(result.writerLockHolder).toBe("instance-a");
    expect(result.storageReady).toBe(true);
  });

  it("未持有 writer lock 时 ready 失败（单实例约束）", async () => {
    const s = setup();
    const result = await checkYjsReadiness(s.options);
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/writer lock/);
    expect(result.writerLock).toBe(false);
  });

  it("第二个实例抢不到锁时 ready 失败", async () => {
    const s = setup();
    await s.writerLock.acquire("instance-a", NOW);
    // 第二个实例用同一个 lock 对象尝试（模拟共享锁）。
    const second = await s.writerLock.acquire("instance-b", NOW);
    expect(second.ok).toBe(false);
    // readiness 反映当前持有者。
    const result = await checkYjsReadiness(s.options);
    expect(result.writerLockHolder).toBe("instance-a");
  });

  it("reports active room 与 connection 计数", async () => {
    const s = setup();
    await s.writerLock.acquire("instance-a", NOW);
    s.setConnections(3);
    const result = await checkYjsReadiness(s.options);
    expect(result.activeRooms).toBe(0);
    expect(result.activeConnections).toBe(3);
  });
});

describe("安全 metrics（任务 8.6）", () => {
  it("只包含活跃计数与数值 counters", async () => {
    const s = setup();
    s.setConnections(2);
    const snapshot = collectYjsMetrics(s.options, { syncBytes: 1024, commandRejected: 1 });
    expect(snapshot.activeConnections).toBe(2);
    expect(snapshot.counters).toEqual({ syncBytes: 1024, commandRejected: 1 });
    // 非数值 counter 被过滤。
    const filtered = collectYjsMetrics(s.options, {
      syncBytes: 1,
      bogus: "secret" as unknown as number
    });
    expect(filtered.counters).toEqual({ syncBytes: 1 });
  });

  it("counters 只加不减，延迟按平均聚合（不保留样本）", () => {
    const counters = new YjsMetricsCounters();
    counters.increment("syncBytes", 100);
    counters.increment("syncBytes", 50);
    counters.increment("commandAccepted");
    counters.observeLatency("commandLatency", 10);
    counters.observeLatency("commandLatency", 30);

    const snapshot = counters.snapshot();
    expect(snapshot.syncBytes).toBe(150);
    expect(snapshot.commandAccepted).toBe(1);
    expect(snapshot.commandLatency_count).toBe(2);
    expect(snapshot.commandLatency_avgMs).toBe(20);
  });
});

describe("日志脱敏（任务 8.6）", () => {
  it("白名单字段保留，额外字段被剔除", () => {
    // 传入运行时多余字段（类型上不允许，但真实调用方可能误传），验证白名单剔除。
    const sanitized = sanitizeSyncLogEvent({
      event: "command-accepted",
      status: 200,
      canvasId: "canvas-a",
      revision: 5,
      commandId: "cmd-1",
      latencyMs: 12.5,
      prompt: "用户提示词",
      yjsBytes: "AAAA",
      signedUrl: "https://x?sig=1"
    } as never);
    expect(sanitized).toEqual({
      event: "command-accepted",
      status: 200,
      canvasId: "canvas-a",
      revision: 5,
      commandId: "cmd-1",
      latencyMs: 12.5
    });
    expect(Object.keys(sanitized)).not.toContain("prompt");
    expect(JSON.stringify(sanitized)).not.toContain("sig=1");
  });

  it("session/channel 维度字段在白名单内且不含 payload", () => {
    const sanitized = sanitizeSyncLogEvent({
      event: "channel-message",
      status: 200,
      canvasId: "c",
      channel: "task-activity",
      cursor: 42,
      record: { taskKey: "t", result: "SECRET" },
      prompt: "SECRET"
    } as never);
    expect(sanitized).toEqual({
      event: "channel-message",
      status: 200,
      canvasId: "c",
      channel: "task-activity",
      cursor: 42
    });
    expect(JSON.stringify(sanitized)).not.toContain("SECRET");
  });

  it("缺少可选字段时不产生 undefined 键", () => {
    const sanitized = sanitizeSyncLogEvent({ event: "sync-connected", status: 101, canvasId: "c" });
    expect(Object.values(sanitized).every((value) => value !== undefined)).toBe(true);
  });

  it("签名 URL / 凭据不出现在任何受支持事件里", () => {
    const events: Parameters<typeof sanitizeSyncLogEvent>[0][] = [
      { event: "command-rejected", status: 400, canvasId: "c", code: "invalid-edge-endpoint" },
      { event: "room-quarantined", status: 503, canvasId: "c", code: "checksum-mismatch" },
      { event: "projection-failed", status: 500, canvasId: "c", code: "storage-failed" }
    ];
    for (const event of events) {
      const json = JSON.stringify(sanitizeSyncLogEvent(event));
      expect(json).not.toContain("X-Amz-Signature");
      expect(json).not.toContain("prompt");
      expect(json).not.toContain("blob:");
    }
  });
});
