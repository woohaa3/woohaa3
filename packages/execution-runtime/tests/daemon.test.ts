import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startExecutorDaemon } from "../src/daemon.js";
import { createExecutorClient, followTurn } from "../src/client.js";
import { TurnStore } from "../src/turns.js";
import type { Executor } from "../src/protocol.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempState(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa3-executor-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function start(executors: Executor[] = []) {
  const stateDir = tempState();
  const daemon = await startExecutorDaemon({
    socketPath: path.join(stateDir, "executor.sock"),
    stateDir,
    token: "test-token",
    workspaceKey: "workspace-a",
    executors
  });
  cleanups.push(() => daemon.close());
  const client = createExecutorClient({ socketPath: daemon.socketPath, token: "test-token", workspaceKey: "workspace-a" });
  return { daemon, client, stateDir, socketPath: daemon.socketPath };
}

describe("woohaa3-executor daemon", () => {
  it("拒绝错误 token，health 报告 workspace", async () => {
    const { client, socketPath } = await start();
    const wrong = createExecutorClient({ socketPath, token: "bad", workspaceKey: "workspace-a" });
    await expect(wrong.health()).rejects.toThrow("身份校验失败");
    const health = await client.health();
    expect(health).toMatchObject({ protocolVersion: 1, workspaceKey: "workspace-a" });
    for (const method of ["ensure", "stop", "stopAll", "query", "events"]) {
      await expect(client.call(method, {})).rejects.toThrow("未知 Executor 方法");
    }
  });

  it("执行 prepared turn 并通过 cursor 跟随事件", async () => {
    const echo: Executor = {
      id: "echo",
      kind: "any",
      async run(input, context) {
        context.emit("message", { text: "hello" });
        return { status: "succeeded", result: { hash: input.prepared?.preparedHash } };
      }
    };
    const { client } = await start([echo]);
    const view = await client.runTurn({
      turnId: "turn-1",
      requestId: "req-1",
      kind: "agent",
      prepared: {
        schemaVersion: 1,
        roleRef: { namespacedId: "test/echo", roleId: "echo", extensionId: "test", revision: "1", descriptorDigest: "d", artifactId: "a" },
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        nativeCapabilities: [],
        output: { kind: "reply" },
        inputDigest: "a",
        contextDigest: "b",
        attachmentDigests: [],
        target: { canvasId: "c" },
        preparedHash: "hash-1"
      }
    });
    expect(view).toMatchObject({ turnId: "turn-1", status: "running", preparedHash: "hash-1" });
    const final = await followTurn(client, "turn-1", { intervalMs: 10 });
    expect(final).toMatchObject({ status: "succeeded", result: { hash: "hash-1" } });
    const page = await client.turnEvents("turn-1", 0);
    expect(page.events.map((event) => event.type)).toEqual(["accepted", "message", "completed"]);
    expect((await client.queryTurn("turn-1"))?.status).toBe("succeeded");
  });

  it("turn.run 按 turnId/requestId 幂等，取消后迟到的结果不改写终态", async () => {
    let release!: () => void;
    const slow: Executor = {
      id: "slow",
      kind: "any",
      run: () => new Promise((resolve) => { release = () => resolve({ status: "succeeded", result: { late: true } }); })
    };
    const { client } = await start([slow]);
    const first = await client.runTurn({ turnId: "turn-2", requestId: "req-2", kind: "generation", executor: "slow" });
    const second = await client.runTurn({ turnId: "turn-2", requestId: "req-2", kind: "generation", executor: "slow" });
    expect(second.turnId).toBe(first.turnId);
    await expect(client.runTurn({ turnId: "turn-2", requestId: "other", kind: "generation" })).rejects.toThrow("不同 requestId");
    expect((await client.cancelTurn("turn-2"))?.status).toBe("cancelled");
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await client.queryTurn("turn-2"))).toMatchObject({ status: "cancelled", error: { code: "cancelled" } });
  });

  it("proc.ensure/stop 支持 stdio 子进程与事件转发", async () => {
    const { client, stateDir } = await start();
    const handle = await client.ensure({
      adapterId: "test-agent",
      owner: "owner",
      connectionId: "connection",
      command: process.execPath,
      args: ["-e", "process.stdin.on('data', d => process.stdout.write(d))"],
      cwd: stateDir,
      kind: "stdio"
    });
    expect(handle.stdioPath).toBeTruthy();
    const received = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(handle.stdioPath!);
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("stdio timeout")); }, 3_000);
      let buffer = "";
      socket.once("connect", () => socket.write("ping\n"));
      socket.on("data", (chunk) => {
        buffer += String(chunk);
        if (buffer.includes("ping")) { clearTimeout(timer); socket.destroy(); resolve(buffer); }
      });
      socket.once("error", reject);
    });
    expect(received).toContain("ping");
    expect((await client.listProcesses()).processes[0]?.adapterId).toBe("test-agent");
    await client.stop({ adapterId: "test-agent", owner: "owner", connectionId: "connection" });
    expect((await client.listProcesses()).processes).toEqual([]);
  });

  it("replays generated artifacts older than the memory window, including after restart", async () => {
    const stateDir = tempState();
    const writer: Executor = { id: "writer", kind: "any", async run(_input, context) {
      context.emit("generated-image", { savedPath: "/codex/generated_images/a.png", codexHome: "/codex" });
      for (let index = 0; index < 2005; index++) context.emit("stage", { index });
      return { status: "succeeded" };
    } };
    const store = new TurnStore({ stateDir });
    store.run({ turnId: "artifact", requestId: "artifact", kind: "generation", executor: "writer" }, [writer], undefined, {
      stateDir, workspaceKey: "test", processes: { ensure: async () => { throw Error("unused"); }, stop: async () => undefined }
    });
    await Promise.resolve();
    for (const current of [store, new TurnStore({ stateDir })]) {
      const page = current.events("artifact");
      expect(page.events[1]).toMatchObject({ cursor: 2, type: "generated-image", payload: { savedPath: "/codex/generated_images/a.png" } });
      expect(page.events.at(-1)).toMatchObject({ type: "completed", cursor: page.cursor });
      expect(current.events("artifact", page.cursor - 2).events).toHaveLength(2);
    }
  });

  it("daemon 重启后把中断回合结算为 failed，不自动重跑", async () => {
    const stateDir = tempState();
    const hanging: Executor = { id: "hang", kind: "any", run: () => new Promise(() => undefined) };
    const first = new TurnStore({ stateDir });
    const deps = {
      stateDir,
      workspaceKey: "test",
      processes: { ensure: async () => { throw new Error("unused"); }, stop: async () => undefined }
    };
    first.run({ turnId: "running", requestId: "req-running", kind: "agent", executor: "hang" }, [hanging], "hang", deps);
    const completed = first.run({ turnId: "done", requestId: "req-done", kind: "agent", executor: "hang" }, [hanging], "hang", deps);
    first.cancel("done");
    const reopened = new TurnStore({ stateDir });
    expect(reopened.get("running")).toMatchObject({ status: "failed", error: { code: "executor-restarted" } });
    expect(reopened.get("done")).toMatchObject({ status: "cancelled" });
    expect(completed.turnId).toBe("done");
    // Recovery must persist every loaded record, including interrupted turns.
    const twice = new TurnStore({ stateDir });
    expect(twice.get("running")).toMatchObject({ status: "failed", error: { code: "executor-restarted" } });
    expect(twice.get("done")).toMatchObject({ status: "cancelled" });
    first.cancel("running");
  });
});
