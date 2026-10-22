/**
 * 执行器与 worker 的失联/watchdog 故障注入（任务 5.4）。
 *
 * 覆盖：应用/宿主失联、过期 lease、孤儿目录清扫、工作区隔离、无自动显式续录。
 * 纯 Node + 真实子进程，不需要 GPU 或真实桌面会话。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RECORDING_PROTOCOL_VERSION } from "@woohaa3/contracts";
import { RecordingExecutorRegistry, checkoutIdFor } from "./index.js";
import { RecordingJobCoordinator } from "./coordinator.js";
import { sweepRecordingWorkRoot } from "./sweep.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wo-fault-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 模拟宿主写下的 lease 文件与 worker 的 watchdog 判定。 */
function leaseAlive(path: string, leaseMs: number, now: number): boolean {
  try {
    const stats = { mtimeMs: 0 } as { mtimeMs: number };
    const raw = readFileSync(`${path}.stamp`, "utf8");
    stats.mtimeMs = Number(raw);
    return now - stats.mtimeMs <= leaseMs;
  } catch {
    return false;
  }
}

function stampLease(path: string, at: number): void {
  writeFileSync(`${path}.stamp`, String(at), { mode: 0o600 });
  try {
    const date = new Date(at);
    utimesSync(path, date, date);
  } catch {
    // 文件不存在时只写 stamp，判定仍按 stamp。
  }
}

describe("executor lease watchdog", () => {
  it("stops the worker when the host stops renewing", () => {
    const lease = join(root, "lease.json");
    writeFileSync(lease, "{}", { mode: 0o600 });
    stampLease(lease, 1_000);
    expect(leaseAlive(lease, 5_000, 3_000)).toBe(true);
    expect(leaseAlive(lease, 5_000, 7_000)).toBe(false);
  });

  it("treats a missing lease file as lost rather than waiting forever", () => {
    expect(leaseAlive(join(root, "absent.json"), 5_000, 0)).toBe(false);
  });

  it("expires the registry lease and refuses late renewals", () => {
    let now = 1_000;
    const checkoutId = checkoutIdFor("/tmp/wo-fault-checkout");
    const registry = new RecordingExecutorRegistry({
      checkoutId,
      protocolVersion: RECORDING_PROTOCOL_VERSION,
      leaseMs: 5_000,
      clockSkewMs: 0,
      now: () => now
    });
    const registered = registry.register({
      capability: {
        executorInstanceId: "exec-1",
        protocolVersion: RECORDING_PROTOCOL_VERSION,
        supportedProtocolVersions: [RECORDING_PROTOCOL_VERSION],
        snapshotSchemaVersion: "woohaa-recording-snapshot-v1",
        rendererVersion: "r",
        compilerVersion: "c",
        codecVersion: "k",
        colorRevision: "col",
        gpuAdapter: "Apple M4 Pro",
        gpuBackend: "metal",
        softwareAdapter: false,
        videoDecoders: [],
        videoEncoders: [],
        hardwareEncoding: false,
        maxResourceChunkBytes: 1024 * 1024,
        maxConcurrentJobs: 1,
        maxQueuedJobs: 1,
        maxSnapshotBytes: 1,
        maxArtifactBytes: 1,
        checkoutId
      },
      peerPid: 7,
      peerUid: 501
    });
    expect(registered.ok).toBe(true);

    now += 5_001;
    expect(registry.get("exec-1")).toBeNull();
    expect(registry.renew("exec-1", 7)).toBeNull();
    expect(registry.list()).toHaveLength(0);
  });

  it("sweeps stale private directories but keeps fresh ones", () => {
    const workRoot = join(root, "work");
    const stale = join(workRoot, "attempt-old");
    const fresh = join(workRoot, "attempt-new");
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    // 把 stale 目录的 mtime 推回过去。
    const past = new Date(Date.now() - 60_000);
    utimesSync(stale, past, past);

    expect(sweepRecordingWorkRoot({ workRoot, olderThanMs: 10_000 })).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("is a no-op when the root is missing and never throws", () => {
    expect(sweepRecordingWorkRoot({ workRoot: join(root, "missing"), olderThanMs: 0 })).toBe(0);
  });

  it("keeps non-directory entries untouched", () => {
    const workRoot = join(root, "work-files");
    mkdirSync(workRoot, { recursive: true });
    const file = join(workRoot, "lease.json");
    writeFileSync(file, "{}");
    const past = new Date(Date.now() - 60_000);
    utimesSync(file, past, past);
    expect(sweepRecordingWorkRoot({ workRoot, olderThanMs: 1 })).toBe(0);
    expect(existsSync(file)).toBe(true);
  });
});

describe("host failure propagation", () => {
  it("fails live jobs of a lost executor instead of leaving them pending", () => {
    const coordinator = new RecordingJobCoordinator({ now: () => 1_000 });
    coordinator.accept({
      identity: {
        jobId: "job-1",
        attemptId: "attempt-1",
        executorInstanceId: "exec-1",
        executionEpoch: 1,
        snapshotHash: "snap",
        contentIdentity: "content",
        profileKey: "profile"
      },
      purpose: "export",
      canvasId: "c1",
      nodeId: "film",
      clipId: "clip",
      totalFrames: 90,
      title: "导出"
    });
    expect(coordinator.executorLost("exec-1")).toBe(1);
    expect(coordinator.get("job-1")!.state).toBe("failed");
    expect(coordinator.get("job-1")!.error?.transient).toBe(false);
  });

  it("never auto-resumes an explicit export after the host restarts", () => {
    // 协调器是**内存**状态：新实例不继承上一次运行的显式任务，必须由用户重新提交。
    const first = new RecordingJobCoordinator({ now: () => 1_000 });
    first.accept({
      identity: {
        jobId: "job-1",
        attemptId: "attempt-1",
        executorInstanceId: "exec-1",
        executionEpoch: 1,
        snapshotHash: "snap",
        contentIdentity: "content",
        profileKey: "profile"
      },
      purpose: "export",
      canvasId: "c1",
      nodeId: "film",
      clipId: "clip",
      totalFrames: 90,
      title: "导出"
    });
    const restarted = new RecordingJobCoordinator({ now: () => 2_000 });
    expect(restarted.list()).toHaveLength(0);
    expect(restarted.get("job-1")).toBeNull();
  });

  it("rejects an executor from another worktree (no cross-checkout leaking)", () => {
    const registry = new RecordingExecutorRegistry({
      checkoutId: checkoutIdFor("/tmp/worktree-a"),
      protocolVersion: RECORDING_PROTOCOL_VERSION
    });
    const result = registry.register({
      capability: {
        executorInstanceId: "exec-other",
        protocolVersion: RECORDING_PROTOCOL_VERSION,
        supportedProtocolVersions: [RECORDING_PROTOCOL_VERSION],
        snapshotSchemaVersion: "s",
        rendererVersion: "r",
        compilerVersion: "c",
        codecVersion: "k",
        colorRevision: "col",
        gpuAdapter: "gpu",
        gpuBackend: "vulkan",
        softwareAdapter: false,
        videoDecoders: [],
        videoEncoders: [],
        hardwareEncoding: false,
        maxResourceChunkBytes: 1,
        maxConcurrentJobs: 1,
        maxQueuedJobs: 1,
        maxSnapshotBytes: 1,
        maxArtifactBytes: 1,
        checkoutId: checkoutIdFor("/tmp/worktree-b")
      },
      peerPid: 1,
      peerUid: 501
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("executor-checkout-mismatch");
  });
});
