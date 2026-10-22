/**
 * Task Service dispatch 配置（change: replace-worker-db-polling-with-dispatcher，任务 1.4）。
 *
 * 校验 recovery interval/jitter、lease、concurrency 与 shutdown grace 的默认值、合法范围
 * 与安全下限：正常调度不再有 100ms poll interval 配置，recovery 必须远高于旧轮询频率。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEASE_MS,
  DEFAULT_RECOVERY_INTERVAL_MS,
  DEFAULT_RECOVERY_JITTER_MS,
  DEFAULT_SHUTDOWN_GRACE_MS,
  DEFAULT_WORKER_CONCURRENCY,
  MAX_WORKER_CONCURRENCY,
  MIN_RECOVERY_INTERVAL_MS,
  TASK_MULTI_INSTANCE_ENV,
  resolveTaskServiceConfig
} from "../src/config/env.js";

const base = { WOOHAA3_TASK_STORE_PATH: "/tmp/task.sqlite" };

function config(env: Record<string, string | undefined>) {
  const result = resolveTaskServiceConfig({ ...base, ...env });
  if (!result.ok) throw new Error(result.reason);
  return result.config;
}

describe("resolveTaskServiceConfig 调度配置", () => {
  it("默认值满足恢复与并发的安全边界", () => {
    const resolved = config({});
    expect(resolved.workerConcurrency).toBe(DEFAULT_WORKER_CONCURRENCY);
    expect(resolved.workerConcurrency).toBe(MAX_WORKER_CONCURRENCY);
    expect(resolved.leaseMs).toBe(DEFAULT_LEASE_MS);
    expect(resolved.recoveryIntervalMs).toBe(DEFAULT_RECOVERY_INTERVAL_MS);
    expect(resolved.recoveryJitterMs).toBe(DEFAULT_RECOVERY_JITTER_MS);
    expect(resolved.shutdownGraceMs).toBe(DEFAULT_SHUTDOWN_GRACE_MS);
    // recovery 周期必须远高于旧 100ms 轮询。
    expect(resolved.recoveryIntervalMs).toBeGreaterThanOrEqual(MIN_RECOVERY_INTERVAL_MS);
    expect(resolved.recoveryIntervalMs).toBeGreaterThan(1000);
  });

  it("并发准入上限为 2000：超过即封顶", () => {
    expect(MAX_WORKER_CONCURRENCY).toBe(2000);
    expect(config({ WOOHAA3_TASK_WORKER_CONCURRENCY: "9999" }).workerConcurrency).toBe(2000);
    expect(config({ WOOHAA3_TASK_WORKER_CONCURRENCY: "2000" }).workerConcurrency).toBe(2000);
    expect(config({ WOOHAA3_TASK_WORKER_CONCURRENCY: "64" }).workerConcurrency).toBe(64);
  });

  it("低于安全下限的 recovery interval 被钳住，不退化为高频轮询", () => {
    expect(config({ WOOHAA3_TASK_RECOVERY_INTERVAL_MS: "100" }).recoveryIntervalMs).toBe(
      MIN_RECOVERY_INTERVAL_MS
    );
    expect(config({ WOOHAA3_TASK_RECOVERY_INTERVAL_MS: "15000" }).recoveryIntervalMs).toBe(15000);
  });

  it("非法/缺省值回落到默认，jitter 允许为 0", () => {
    expect(config({ WOOHAA3_TASK_WORKER_CONCURRENCY: "0" }).workerConcurrency).toBe(
      DEFAULT_WORKER_CONCURRENCY
    );
    expect(config({ WOOHAA3_TASK_LEASE_MS: "abc" }).leaseMs).toBe(DEFAULT_LEASE_MS);
    expect(config({ WOOHAA3_TASK_RECOVERY_JITTER_MS: "0" }).recoveryJitterMs).toBe(0);
  });

  it("lease 有下限，避免 heartbeat 与恢复窗口退化", () => {
    expect(config({ WOOHAA3_TASK_LEASE_MS: "1000" }).leaseMs).toBe(30000);
  });

  it("SQLite profile 声明多实例时启动失败", () => {
    const result = resolveTaskServiceConfig({
      ...base,
      [TASK_MULTI_INSTANCE_ENV]: "true"
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("单");
  });

  it("缺少 store 路径时给出可诊断原因", () => {
    const result = resolveTaskServiceConfig({});
    expect(result.ok).toBe(false);
  });
});
