/**
 * 本机录制执行器通道：路径、注册与工作区隔离
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 1.4）。
 *
 * 这是**非渲染**集成测试：真实建立 Unix-domain socket，验证注册/续期/跨 worktree 拒绝，
 * 以及「WebView 断开不关闭 executor」。不启动 GPU、不伪造渲染结果。
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RECORDING_PROTOCOL_VERSION } from "@woohaa3/contracts";
import {
  RecordingExecutorRegistry,
  checkoutIdFor,
  cleanRecordingExecutorDirectory,
  connectRecordingExecutor,
  recordingExecutorPaths,
  startRecordingExecutorServer,
  type RecordingExecutorCapability,
  type RecordingExecutorServer
} from "./index.js";

const MAIN_CHECKOUT_DIRECTORY = "/tmp/wo-ck-a";
const CHECKOUT = checkoutIdFor(MAIN_CHECKOUT_DIRECTORY);

function capability(overrides: Partial<RecordingExecutorCapability> = {}): RecordingExecutorCapability {
  return {
    executorInstanceId: "executor-1",
    protocolVersion: RECORDING_PROTOCOL_VERSION,
    supportedProtocolVersions: [RECORDING_PROTOCOL_VERSION],
    snapshotSchemaVersion: "woohaa-recording-snapshot-v1",
    rendererVersion: "bevy-recorder-1",
    compilerVersion: "film-set-compiler-1",
    codecVersion: "openh264-2.4",
    colorRevision: "srgb-1",
    gpuAdapter: "Apple M4 Pro",
    gpuBackend: "metal",
    softwareAdapter: false,
    videoDecoders: ["h264"],
    videoEncoders: ["h264"],
    hardwareEncoding: true,
    maxResourceChunkBytes: 1024 * 1024,
    maxConcurrentJobs: 1,
    maxQueuedJobs: 256,
    maxSnapshotBytes: 8 * 1024 * 1024,
    maxArtifactBytes: 256 * 1024 * 1024,
    checkoutId: CHECKOUT,
    ...overrides
  };
}

let root: string;
let servers: RecordingExecutorServer[] = [];

beforeEach(() => {
  // 保持 root 足够短：Linux sun_path 上限 108 字节，测试也不应依赖长临时路径。
  root = mkdtempSync(join(tmpdir(), "wo-rec-"));
  servers = [];
});

afterEach(async () => {
  for (const server of servers) await server.close();
  rmSync(root, { recursive: true, force: true });
});

function pathsFor(checkoutDirectory = MAIN_CHECKOUT_DIRECTORY) {
  return recordingExecutorPaths({ runtimeRoot: root, checkoutDirectory });
}

describe("recording executor paths", () => {
  it("uses a private directory bound to the checkout", () => {
    const paths = pathsFor();
    expect(paths.directory.startsWith(root)).toBe(true);
    expect(paths.directory.endsWith(paths.checkoutId)).toBe(true);
    expect(paths.checkoutId).toBe(CHECKOUT);
  });

  it("derives different identities for different worktrees", () => {
    const a = recordingExecutorPaths({ runtimeRoot: root, checkoutDirectory: "/tmp/worktree-a" });
    const b = recordingExecutorPaths({ runtimeRoot: root, checkoutDirectory: "/tmp/worktree-b" });
    expect(a.checkoutId).not.toBe(b.checkoutId);
    expect(a.socketPath).not.toBe(b.socketPath);
  });

  it.skipIf(process.platform === "win32")("rejects an over-long socket path instead of silently truncating", () => {
    // Windows 走命名管道，没有 Linux sun_path 的 108 字节限制。
    expect(() =>
      recordingExecutorPaths({ runtimeRoot: `/${"x".repeat(150)}`, checkoutDirectory: "/tmp/a" })
    ).toThrow(/socket 路径过长/);
  });
});

describe("recording executor registry", () => {
  it("rejects a registration whose nonce does not match", () => {
    const registry = new RecordingExecutorRegistry({
      checkoutId: CHECKOUT,
      registrationNonce: "expected-nonce",
      protocolVersion: RECORDING_PROTOCOL_VERSION
    });
    const result = registry.register({
      capability: capability(),
      registrationNonce: "wrong-nonce",
      peerPid: 1,
      peerUid: 501
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("executor-unauthorized");
  });

  it("rejects an executor from another worktree", () => {
    const registry = new RecordingExecutorRegistry({
      checkoutId: CHECKOUT,
      protocolVersion: RECORDING_PROTOCOL_VERSION
    });
    const result = registry.register({
      capability: capability({ checkoutId: checkoutIdFor("/tmp/other-worktree") }),
      peerPid: 1,
      peerUid: 501
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("executor-checkout-mismatch");
  });

  it("rejects an incompatible protocol version", () => {
    const registry = new RecordingExecutorRegistry({
      checkoutId: CHECKOUT,
      protocolVersion: RECORDING_PROTOCOL_VERSION
    });
    const result = registry.register({
      capability: capability({
        protocolVersion: "RECORDING_PROTOCOL_VERSION_2",
        supportedProtocolVersions: ["RECORDING_PROTOCOL_VERSION_2"]
      }),
      peerPid: 1,
      peerUid: 501
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("executor-protocol-version-mismatch");
  });

  it("rejects incomplete capability instead of assuming defaults", () => {
    const registry = new RecordingExecutorRegistry({
      checkoutId: CHECKOUT,
      protocolVersion: RECORDING_PROTOCOL_VERSION
    });
    const result = registry.register({
      capability: capability({ rendererVersion: "" }),
      peerPid: 1,
      peerUid: 501
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("executor-capability-incomplete");
  });

  it("expires a lease and bumps the execution epoch on re-registration", () => {
    let now = 1_000;
    const registry = new RecordingExecutorRegistry({
      checkoutId: CHECKOUT,
      protocolVersion: RECORDING_PROTOCOL_VERSION,
      leaseMs: 5_000,
      clockSkewMs: 0,
      now: () => now
    });
    const first = registry.register({ capability: capability(), peerPid: 7, peerUid: 501 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.registration.executionEpoch).toBe(1);
    expect(registry.get("executor-1")).not.toBeNull();

    now += 5_001;
    expect(registry.get("executor-1")).toBeNull();
    expect(registry.list()).toHaveLength(0);

    const second = registry.register({ capability: capability(), peerPid: 7, peerUid: 501 });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.registration.executionEpoch).toBeGreaterThan(first.registration.executionEpoch);
  });

  it("renews only for the registering peer", () => {
    let now = 1_000;
    const registry = new RecordingExecutorRegistry({
      checkoutId: CHECKOUT,
      protocolVersion: RECORDING_PROTOCOL_VERSION,
      leaseMs: 5_000,
      clockSkewMs: 0,
      now: () => now
    });
    registry.register({ capability: capability(), peerPid: 7, peerUid: 501 });
    expect(registry.renew("executor-1", 8)).toBeNull();
    now += 4_000;
    expect(registry.renew("executor-1", 7)).not.toBeNull();
    now += 4_000;
    expect(registry.get("executor-1")).not.toBeNull();
  });

  it("treats a software adapter as not capable of accepted rendering", () => {
    const registry = new RecordingExecutorRegistry({
      checkoutId: CHECKOUT,
      protocolVersion: RECORDING_PROTOCOL_VERSION
    });
    registry.register({
      capability: capability({ gpuAdapter: "llvmpipe", softwareAdapter: true, gpuBackend: "vulkan" }),
      peerPid: 7,
      peerUid: 501
    });
    expect(registry.supportsHardwareRendering("executor-1")).toBe(false);
  });
});

describe("recording executor socket", () => {
  it("registers over a real unix socket and ignores a wrong nonce", async () => {
    const paths = pathsFor();
    const accepted: string[] = [];
    const server = await startRecordingExecutorServer({
      paths,
      registrationNonce: "good-nonce",
      handle: inbound => {
        // `payload` 已经是 `capabilityRequest` 的内容（envelope 只保留一个 payload 键）。
        const capabilityRequest = inbound.message.payload as {
          registrationNonce?: string;
          capability?: RecordingExecutorCapability;
        };
        if (!capabilityRequest.capability) {
          return {
            protocolVersion: RECORDING_PROTOCOL_VERSION,
            sequence: "1",
            capabilityResponse: { accepted: false }
          };
        }
        if (capabilityRequest.registrationNonce !== "good-nonce") {
          return {
            protocolVersion: RECORDING_PROTOCOL_VERSION,
            sequence: "1",
            capabilityResponse: {
              accepted: false,
              error: { stage: "RECORDING_ERROR_STAGE_CAPABILITY", code: "executor-unauthorized", message: "bad nonce" }
            }
          };
        }
        accepted.push(capabilityRequest.capability?.executorInstanceId ?? "unknown");
        return {
          protocolVersion: RECORDING_PROTOCOL_VERSION,
          sequence: "1",
          capabilityResponse: { accepted: true, capability: capabilityRequest.capability }
        };
      }
    });
    servers.push(server);

    // 文件权限：目录 0700、socket 0600（Windows 不提供 POSIX mode；由用户私有临时目录隔离）。
    if (process.platform !== "win32") {
      expect(statSync(paths.directory).mode & 0o777).toBe(0o700);
      expect(statSync(paths.socketPath).mode & 0o777).toBe(0o600);
    }

    const good = connectRecordingExecutor({
      socketPath: paths.socketPath,
      noncePath: paths.noncePath,
      capability: capability(),
      onTerminate: () => undefined
    });
    await expect(good.registered).resolves.toEqual({ ok: true, message: undefined });
    expect(accepted).toEqual(["executor-1"]);

    // 错的 nonce：用另一个目录写错误凭据，验证注册被拒且不重试。
    const wrongPaths = recordingExecutorPaths({ runtimeRoot: root, checkoutDirectory: "/tmp/other-checkout" });
    rmSync(wrongPaths.directory, { recursive: true, force: true });
    const decisions: string[] = [];
    const wrong = connectRecordingExecutor({
      socketPath: paths.socketPath,
      noncePath: (() => {
        const file = join(root, "wrong.nonce");
        writeFileSync(file, "wrong-nonce", { mode: 0o600 });
        return file;
      })(),
      capability: capability(),
      onTerminate: reason => decisions.push(reason.code)
    });
    const result = await wrong.registered;
    expect(result.ok).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(decisions).toEqual(["executor-unauthorized"]);
    expect(wrong.alive()).toBe(false);

    await good.close();
    await wrong.close();
  });

  it("keeps the executor registered when no webview is involved", async () => {
    const paths = pathsFor();
    const registry = new RecordingExecutorRegistry({
      checkoutId: CHECKOUT,
      registrationNonce: "nonce",
      protocolVersion: RECORDING_PROTOCOL_VERSION,
      leaseMs: 10_000
    });
    const server = await startRecordingExecutorServer({
      paths,
      registrationNonce: "nonce",
      handle: inbound => {
        const request = inbound.message.payload as {
          registrationNonce?: string;
          capability?: RecordingExecutorCapability;
        };
        if (!request.capability) return undefined;
        const registered = registry.register({
          capability: request.capability,
          registrationNonce: request.registrationNonce,
          peerPid: inbound.peer.peerPid,
          peerUid: inbound.peer.peerUid
        });
        return {
          protocolVersion: RECORDING_PROTOCOL_VERSION,
          sequence: "1",
          capabilityResponse: registered.ok
            ? { accepted: true, capability: request.capability }
            : {
                accepted: false,
                error: {
                  stage: "RECORDING_ERROR_STAGE_CAPABILITY",
                  code: registered.code,
                  message: registered.message
                }
              }
        };
      }
    });
    servers.push(server);

    const client = connectRecordingExecutor({
      socketPath: paths.socketPath,
      noncePath: paths.noncePath,
      capability: capability(),
      heartbeatMs: 20,
      onTerminate: () => undefined
    });
    await expect(client.registered).resolves.toEqual({ ok: true, message: undefined });
    expect(registry.get("executor-1")).not.toBeNull();
    // 模拟「页面关闭」：本测试根本没有 WebView，注册仍然有效。
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(registry.list()).toHaveLength(1);
    expect(server.connectionCount()).toBe(1);

    // peer 断开才移除（对应 supervisor 退出）；Windows 命名管道的 close 事件可能稍晚。
    await client.close();
    const deadline = Date.now() + 1_000;
    while (server.connectionCount() > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(server.connectionCount()).toBe(0);
  });

  it("cleans its own runtime files on close", async () => {
    const paths = pathsFor();
    const server = await startRecordingExecutorServer({
      paths,
      registrationNonce: "n",
      handle: () => undefined
    });
    cleanRecordingExecutorDirectory(paths);
    await server.close();
    expect(() => statSync(paths.socketPath)).toThrow();
  });
});
