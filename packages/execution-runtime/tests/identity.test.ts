import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startExecutorDaemon } from "../src/daemon.js";
import { createExecutorClient } from "../src/client.js";
import {
  EXECUTOR_IDENTITY_SCHEMA_VERSION,
  EXECUTOR_RUNTIME_VERSION,
  executorIdentityPath,
  isAdoptableIdentity,
  readExecutorIdentity,
  writeExecutorIdentity
} from "../src/identity.js";
import { inspectRuntime, stopExecutorRuntime } from "../src/runtime.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempState(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa3-runtime-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function start(stateDir: string, workspaceKey = "workspace-a", token = "token-a") {
  const daemon = await startExecutorDaemon({
    socketPath: path.join(stateDir, "executor.sock"),
    stateDir,
    token,
    workspaceKey
  });
  cleanups.push(() => daemon.close());
  return daemon;
}

const identity = (overrides: Partial<Parameters<typeof writeExecutorIdentity>[1]> = {}) => ({
  schemaVersion: EXECUTOR_IDENTITY_SCHEMA_VERSION,
  workspaceKey: "workspace-a",
  pid: process.pid,
  socketPath: "/tmp/executor.sock",
  token: "token-a",
  startedAt: Date.now(),
  runtimeVersion: EXECUTOR_RUNTIME_VERSION,
  ...overrides
});

describe("executor runtime identity (task 1.1)", () => {
  it("writes a private identity snapshot with schema and runtime version", () => {
    const stateDir = tempState();
    writeExecutorIdentity(stateDir, identity());
    const snapshot = JSON.parse(fs.readFileSync(executorIdentityPath(stateDir), "utf8")) as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      schemaVersion: EXECUTOR_IDENTITY_SCHEMA_VERSION,
      workspaceKey: "workspace-a",
      runtimeVersion: EXECUTOR_RUNTIME_VERSION
    });
    if (process.platform !== "win32") {
      expect(fs.statSync(stateDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(executorIdentityPath(stateDir)).mode & 0o777).toBe(0o600);
    }
    const read = readExecutorIdentity(stateDir);
    expect(read.ok && read.identity.pid).toBe(process.pid);
  });

  it("rejects legacy snapshots without schemaVersion and incompatible schemas", () => {
    const stateDir = tempState();
    fs.writeFileSync(executorIdentityPath(stateDir), JSON.stringify({ workspaceKey: "workspace-a", pid: process.pid, socketPath: "/tmp/s", token: "t", startedAt: 1 }));
    expect(readExecutorIdentity(stateDir)).toMatchObject({ ok: false, reason: "legacy" });
    const incompatible = identity({ schemaVersion: 1 });
    writeExecutorIdentity(stateDir, incompatible);
    expect(isAdoptableIdentity(incompatible)).toMatchObject({ ok: false });
  });

  it("rejects malformed snapshots instead of guessing defaults", () => {
    const stateDir = tempState();
    fs.writeFileSync(executorIdentityPath(stateDir), JSON.stringify({ schemaVersion: 2, workspaceKey: "", pid: 1, socketPath: "/tmp/s", token: "t", startedAt: 1, runtimeVersion: "0" }));
    expect(readExecutorIdentity(stateDir)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("writes identity on daemon start, refuses a second instance, and clears on stop", async () => {
    const stateDir = tempState();
    const daemon = await start(stateDir);
    const stored = readExecutorIdentity(stateDir);
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.identity).toMatchObject({ pid: daemon.pid, workspaceKey: "workspace-a", schemaVersion: EXECUTOR_IDENTITY_SCHEMA_VERSION });
    await expect(start(stateDir)).rejects.toThrow(/已在运行/);
    // 同一目录里另一个 workspace 的实例只报告，不覆盖也不结束。
    const foreignSocket = path.join(stateDir, "foreign.sock");
    await expect(startExecutorDaemon({ socketPath: foreignSocket, stateDir, token: "token-b", workspaceKey: "workspace-b" }))
      .rejects.toThrow(/已属于 workspace workspace-a/);
    expect(readExecutorIdentity(stateDir)).toMatchObject({ ok: true });
    await daemon.close();
    expect(readExecutorIdentity(stateDir)).toMatchObject({ ok: false, reason: "missing" });
  });
});

describe("runtime status|stop (task 1.2)", () => {
  it("reports healthy, then stops only a matching workspace instance", async () => {
    const stateDir = tempState();
    const daemon = await start(stateDir);
    const healthy = await inspectRuntime({ runtimeDir: stateDir, workspaceKey: "workspace-a" });
    expect(healthy).toMatchObject({ status: "healthy", pid: daemon.pid });
    // 不匹配的 workspace 只报告，不结束实例。
    expect(await inspectRuntime({ runtimeDir: stateDir, workspaceKey: "workspace-b" })).toMatchObject({ status: "workspace-mismatch" });
    expect(await stopExecutorRuntime({ runtimeDir: stateDir, workspaceKey: "workspace-b" })).toMatchObject({ stopped: false });
    expect(await inspectRuntime({ runtimeDir: stateDir, workspaceKey: "workspace-a" })).toMatchObject({ status: "healthy" });
    expect(await stopExecutorRuntime({ runtimeDir: stateDir, workspaceKey: "workspace-a" })).toMatchObject({ stopped: true });
    expect(await inspectRuntime({ runtimeDir: stateDir, workspaceKey: "workspace-a" })).toMatchObject({ status: "missing" });
  });

  it("reports missing and unreachable runtimes without inventing health", async () => {
    const stateDir = tempState();
    expect(await inspectRuntime({ runtimeDir: stateDir, workspaceKey: "workspace-a" })).toMatchObject({ status: "missing" });
    writeExecutorIdentity(stateDir, identity({ pid: 999_999, socketPath: path.join(stateDir, "absent.sock") }));
    expect(await inspectRuntime({ runtimeDir: stateDir, workspaceKey: "workspace-a" })).toMatchObject({ status: "unreachable" });
  });
});

describe("detached module registration (task 4.3)", () => {
  it("keeps a detached registration until its turns settle, then unregisters without cancelling", async () => {
    const stateDir = tempState();
    const modulePath = path.join(stateDir, "module.mjs");
    fs.writeFileSync(modulePath, `export const createExecutor = () => ({ id: "slow", kind: "agent", async run(_input, ctx) {
      await new Promise(resolve => setTimeout(resolve, 150));
      return { status: "succeeded", result: "done" };
    } });`);
    const daemon = await start(stateDir);
    const client = createExecutorClient({ socketPath: daemon.socketPath, token: "token-a", workspaceKey: "workspace-a" });
    await client.call("executor.register", { registrationId: "first", modules: [{ id: "slow", module: modulePath, export: "createExecutor" }] });
    const view = await client.runTurn({ turnId: "t1", requestId: "r1", kind: "agent", executor: "first/slow" });
    expect(view.status).toBe("running");
    expect(await client.detach({ registrationId: "first" })).toMatchObject({ detached: true });
    // detach 期间新宿主可注册同一路径，回合不被取消。
    await client.call("executor.register", { registrationId: "second", modules: [{ id: "slow", module: modulePath, export: "createExecutor" }] });
    expect((await client.queryTurn("t1"))?.status).toBe("running");
    await new Promise(resolve => setTimeout(resolve, 300));
    expect((await client.queryTurn("t1"))?.status).toBe("succeeded");
    const deadline = Date.now() + 3_000;
    let executors = (await client.call<{ executors: Array<{ id: string }> }>("executor.list")).executors;
    while (executors.some(entry => entry.id.startsWith("first/")) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      executors = (await client.call<{ executors: Array<{ id: string }> }>("executor.list")).executors;
    }
    expect(executors.map(entry => entry.id)).toEqual(["second/slow"]);
  });
});
