import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { startExecutorDaemon } from "../../../../../packages/execution-runtime/src/daemon.js";
import { createExecutorClient } from "woohaa3-executor/client";
import type { PreparedAgentRoleTurn } from "@woohaa3/contracts";
import { createExtensionExecutorRuntime } from "./executor-runtime.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const prepared = { schemaVersion: 1, roleRef: { namespacedId: "test/reply", roleId: "reply", extensionId: "test", revision: "1", descriptorDigest: "d", artifactId: "a" }, messages: [{ role: "user", content: "hello" }], tools: [], nativeCapabilities: [], output: { kind: "reply" }, inputDigest: "i", contextDigest: "c", attachmentDigests: [], target: {}, preparedHash: "hash" } as PreparedAgentRoleTurn;

async function fixture(source: string, id = "custom") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-extension-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const module = path.join(dir, "extension.mjs"); fs.writeFileSync(module, source);
  const daemon = await startExecutorDaemon({ stateDir: dir, socketPath: path.join(dir, "daemon.sock"), token: "daemon", workspaceKey: "test" });
  cleanup.push(() => daemon.close());
  const callbacks = new Map<string, (method: string, params: unknown) => Promise<unknown>>();
  const leases: Array<{ turnId: string; requestId: string; owner: string; methods: readonly string[] }> = [];
  const server = net.createServer(socket => {
    let buffer = "";
    socket.on("data", chunk => {
      buffer += String(chunk);
      const lines = buffer.split("\n"); buffer = lines.pop()!;
      for (const line of lines) {
        const request = JSON.parse(line);
        const handler = callbacks.get(request.params.leaseId);
        void Promise.resolve().then(() => {
          if (!handler || request.token !== "host" || request.method !== "extension.call") throw new Error("revoked");
          return handler(request.params.method, request.params.params);
        }).then(result => socket.write(JSON.stringify({ id: request.id, ok: true, result }) + "\n"), error => socket.write(JSON.stringify({ id: request.id, ok: false, error: String(error) }) + "\n"));
      }
    });
  });
  const hostSocket = path.join(dir, "host.sock"); await new Promise<void>(resolve => server.listen(hostSocket, resolve));
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  let next = 0;
  const runtime = createExtensionExecutorRuntime({ socketPath: daemon.socketPath, token: "daemon", workspaceKey: "test", executor: "", bridge: { socketPath: hostSocket, token: "host", workspaceKey: "test" }, hostCalls: {
    registerCall(handler, claims) {
      const leaseId = String(++next); callbacks.set(leaseId, handler);
      if (claims) leases.push({ turnId: claims.turnId, requestId: claims.requestId, owner: claims.owner, methods: claims.methods });
      return { leaseId, release: () => { callbacks.delete(leaseId); } };
    }
  } });
  const definition = { extensionId: "external-extension", executors: [{ id, module, export: "createExecutor" }], activate: () => undefined };
  const client = createExecutorClient({ socketPath: daemon.socketPath, token: "daemon", workspaceKey: "test" });
  return { dir, module, daemon, runtime, definition, callbacks, leases, client };
}

it("loads an extension contribution, scopes host calls, replays results, and never journals credentials", async () => {
  const f = await fixture(`export const createExecutor = () => ({ id: "custom", kind: "agent", async run(input, ctx) {
    const value = await ctx.host.call("credential");
    ctx.emit("stage", { stage: "running" });
    return { status: "succeeded", result: { authorized: value === "credential-never-journal" } };
  } });`);
  const binding = await f.runtime.activate(f.definition, 1); cleanup.push(() => binding!.dispose());
  const input = { executor: "custom", owner: "alice", requestId: "one", prepared, hostCall: async () => "credential-never-journal" };
  expect(await binding!.service.run(input)).toMatchObject({ status: "succeeded", result: { authorized: true } });
  expect(await binding!.service.query(input)).toMatchObject({ status: "succeeded", result: { authorized: true } });
  expect(await binding!.service.query({ ...input, owner: "bob" })).toBeNull();
  expect(f.callbacks.size).toBe(0);
  const journal = fs.readFileSync(path.join(f.dir, "turns.json"), "utf8") + fs.readdirSync(path.join(f.dir, "turns")).map(file => fs.readFileSync(path.join(f.dir, "turns", file), "utf8")).join("");
  expect(journal).not.toContain("credential-never-journal");
  await expect(binding!.service.run({ ...input, executor: "undeclared" })).rejects.toThrow("not declared");
  await binding!.dispose();
  expect(await f.client.call("executor.list")).toEqual({ executors: [] });
  await expect(binding!.service.run({ ...input, requestId: "after-disable" })).rejects.toThrow();
});

it("unload cancels and drains an active turn before removing its host lease", async () => {
  const f = await fixture(`export const createExecutor = () => ({ id: "custom", kind: "agent", async run(input, ctx) {
    await new Promise(resolve => ctx.signal.addEventListener("abort", () => setTimeout(resolve, 30), { once: true }));
    return { status: "cancelled", result: { cleaned: true } };
  } });`);
  const binding = await f.runtime.activate(f.definition, 1);
  const operation = binding!.service.run({ executor: "custom", owner: "alice", requestId: "slow", prepared });
  while ((await f.client.listTurns()).turns.length === 0) await new Promise(resolve => setTimeout(resolve, 5));
  await binding!.dispose();
  expect(await operation).toMatchObject({ status: "cancelled", result: { cleaned: true } });
  expect(f.callbacks.size).toBe(0);
  expect(await f.client.call("executor.list")).toEqual({ executors: [] });
});

it("a bad module cannot leave a partial registration, and missing daemon never executes in the host", async () => {
  const f = await fixture(`export const createExecutor = () => ({ id: "wrong-id", kind: "agent", async run() { return {status:"succeeded"}; } });`);
  await expect(f.runtime.activate(f.definition, 1)).rejects.toThrow("Invalid executor module");
  expect(await f.client.call("executor.list")).toEqual({ executors: [] });
});

/**
 * 宿主没配独立执行器时，扩展必须照常激活。
 *
 * 线上事故：web host 没有 `WOOHAA3_AGENT_RUNTIME_SOCKET/TOKEN/WORKSPACE_KEY`，
 * 于是 sdk-agent / local-agent / oauth-agent 三个声明了 `executors` 的扩展全部
 * `activation-failed`，`/connections` 只剩没有执行器的 remote-server——文本节点与
 * 导演台的模型选择器里一条 Provider 语言模型都没有。声明执行器 ≠ 只能当执行器用：
 * 这些扩展还用 `agent-connection-provider` 提供连接发现。
 */
it("宿主未配置执行器时返回 undefined 而不是让整个扩展激活失败", () => {
  const runtime = createExtensionExecutorRuntime(undefined);
  const definition = { extensionId: "sdk-agent", executors: [{ id: "sdk-agent", module: "./executor", export: "createExecutor" }], activate: () => undefined };
  // 不抛错、也没有执行器能力：扩展层照常继续 activate，执行器缺席只影响真正执行的那条路径。
  return expect(runtime.activate(definition, 1)).resolves.toBeUndefined();
});

it("explicit cancellation revokes host calls immediately and waits for cleanup", async () => {
  const f = await fixture(`export const createExecutor = () => ({ id: "custom", kind: "agent", async run(input, ctx) {
    await new Promise(resolve => ctx.signal.addEventListener("abort", resolve, { once: true }));
    let revoked = false;
    try { await ctx.host.call("credential"); } catch { revoked = true; }
    return { status: "cancelled", result: { revoked } };
  } });`);
  const binding = await f.runtime.activate(f.definition, 1); cleanup.push(() => binding!.dispose());
  const input = { executor: "custom", owner: "alice", requestId: "cancel", prepared, hostCall: async () => "secret" };
  const operation = binding!.service.run(input);
  while ((await f.client.listTurns()).turns.length === 0) await new Promise(resolve => setTimeout(resolve, 5));
  await binding!.service.cancel(input);
  expect(await operation).toMatchObject({ status: "cancelled", result: { revoked: true } });
  expect(f.callbacks.size).toBe(0);
});

it("does not forward a credential resolved after cancellation", async () => {
  const f = await fixture(`export const createExecutor = () => ({ id: "custom", kind: "agent", async run(input, ctx) {
    try { await ctx.host.call("credential"); return { status: "succeeded" }; }
    catch { return { status: "cancelled", result: { revoked: true } }; }
  } });`);
  const binding = await f.runtime.activate(f.definition, 1); cleanup.push(() => binding!.dispose());
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let release!: (value: string) => void;
  const credential = new Promise<string>(resolve => { release = resolve; });
  const input = { executor: "custom", owner: "alice", requestId: "credential-race", prepared,
    hostCall: async () => { started(); return credential; } };
  const operation = binding!.service.run(input);
  await ready;
  const cancellation = binding!.service.cancel(input);
  release("credential-never-forwarded");
  await cancellation;
  expect(await operation).toMatchObject({ status: "cancelled", result: { revoked: true } });
});

it("loads the SDK extension module in the daemon and obtains credentials only through its turn lease", async () => {
  const entry = new URL("../../../../extensions/sdk-agent/dist/executor.js", import.meta.url).href;
  const f = await fixture(`import { createExecutor as sdk } from ${JSON.stringify(entry)};
    export const createExecutor = () => sdk({ transports: { "codex-agent-sdk": { async run(input) {
      if (input.apiKey === "real-key") throw new Error("SDK received the upstream credential");
      return { ok: true, assistantText: "sdk reply", toolCalls: [], finishReason: "stop" };
    } } } });`, "sdk-agent");
  const binding = await f.runtime.activate(f.definition, 1); cleanup.push(() => binding!.dispose());
  const record = { owner: "alice", connectionId: "sdk", adapterId: "openai-responses", name: "SDK", runCategory: "agent-sdk", authMode: "api-key", configRevision: 1, credentialEpoch: 1, runtimeVersion: "codex-agent-sdk@0.161.0:1", models: ["fixture"] };
  let reads = 0;
  const result = await binding!.service.run({ executor: "sdk-agent", owner: "alice", requestId: "sdk", prepared,
    payload: { input: { owner: "alice", canvasId: "canvas", conversationId: "conversation", turnId: "sdk", requestId: "sdk", connection: record, history: [], intent: { action: "discuss", canvasId: "canvas", prompt: "reply", model: "fixture" } }, deployment: { allowHttp: false, hasTools: false, hasAuthoring: false } },
    hostCall: async method => {
      if (method === "connection.get") return record;
      if (method === "connection.credential") { reads++; return { secret: "real-key" }; }
      if (method === "connection.native.get") return null;
      if (["connection.probe", "connection.status"].includes(method)) return null;
      throw new Error(`Unexpected host call: ${method}`);
    }
  });
  expect(result).toMatchObject({ status: "succeeded", result: { outcome: { status: "succeeded", assistantText: "sdk reply" } } });
  expect(reads).toBe(1);
});

it("loads the OAuth extension module in the daemon without moving the token store into its journal", async () => {
  const entry = new URL("../../../../extensions/oauth-agent/dist/executor.js", import.meta.url).href;
  const f = await fixture(`import { createExecutor as oauth } from ${JSON.stringify(entry)};
    export const createExecutor = () => oauth({ createCodex: options => {
      if (options.env.WOOHAA3_CHATGPT_ACCESS_TOKEN !== "oauth-access-token") throw new Error("Missing OAuth authorization");
      return { startThread() { return { async runStreamed() { return { events: (async function* () {
        yield { type: "item.completed", item: { id: "reply", type: "agent_message", text: "oauth reply" } };
        yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
      })() }; } }; } };
    } });`, "oauth-agent");
  const binding = await f.runtime.activate(f.definition, 1); cleanup.push(() => binding!.dispose());
  const result = await binding!.service.run({ executor: "oauth-agent", owner: "alice", requestId: "oauth", prepared,
    payload: { input: { ownerId: "alice", model: "fixture", prompt: "hello", noTools: true }, deployment: { codexHomeDir: path.join(f.dir, "codex"), workspaceDir: path.join(f.dir, "work"), mcpTools: null } },
    hostCall: async method => {
      if (method === "oauth.access-token") return "oauth-access-token";
      throw new Error(`Unexpected host call: ${method}`);
    }
  });
  expect(result).toMatchObject({ status: "succeeded", result: { finalResponse: "oauth reply" } });
  expect(fs.readFileSync(path.join(f.dir, "turns.json"), "utf8")).not.toContain("oauth-access-token");
});

it("re-registers declared modules after daemon restart and loads a changed artifact on upgrade", async () => {
  const f = await fixture(`export const createExecutor = () => ({ id: "custom", kind: "agent", async run() { return { status: "succeeded", result: "v1" }; } });`);
  const first = await f.runtime.activate(f.definition, 1);
  await f.daemon.close();
  const replacement = await startExecutorDaemon({ stateDir: f.dir, socketPath: f.daemon.socketPath, token: "daemon", workspaceKey: "test" });
  cleanup.push(() => replacement.close());
  const input = { executor: "custom", owner: "alice", requestId: "after-restart", prepared };
  expect(await first!.service.run(input)).toMatchObject({ status: "succeeded", result: "v1" });
  await first!.dispose();
  fs.writeFileSync(f.module, `export const createExecutor = () => ({ id: "custom", kind: "agent", async run() { return { status: "succeeded", result: "v2" }; } });`);
  const upgraded = await f.runtime.activate(f.definition, 2);
  expect(await upgraded!.service.run({ ...input, requestId: "after-upgrade" })).toMatchObject({ status: "succeeded", result: "v2" });
  await upgraded!.dispose();
});

it("detaches on host shutdown/reload without cancelling in-flight turns", async () => {
  const f = await fixture(`export const createExecutor = () => ({ id: "custom", kind: "agent", async run(_input, ctx) {
    await new Promise(resolve => setTimeout(resolve, 120));
    return { status: "succeeded", result: "kept-running" };
  } });`);
  const first = await f.runtime.activate(f.definition, 1);
  const operation = first!.service.run({ executor: "custom", owner: "alice", requestId: "shutdown", prepared });
  while ((await f.client.listTurns()).turns.length === 0) await new Promise(resolve => setTimeout(resolve, 5));
  await first!.dispose("shutdown");
  expect(await operation).toMatchObject({ status: "succeeded", result: "kept-running" });
  // 模块注册保留在 daemon 中，供下一宿主接管/回收。
  expect((await f.client.call<{ executors: Array<{ id: string }> }>("executor.list")).executors.some(entry => entry.id.startsWith("external-extension:")))
    .toBe(true);
  const replacement = await f.runtime.activate(f.definition, 2);
  expect(await replacement!.service.run({ executor: "custom", owner: "alice", requestId: "after-shutdown", prepared }))
    .toMatchObject({ status: "succeeded", result: "kept-running" });
  await replacement!.dispose("disable");
});

it("disable and upgrade still cancel and drain only the affected extension turns", async () => {
  const f = await fixture(`export const createExecutor = () => ({ id: "custom", kind: "agent", async run(_input, ctx) {
    await new Promise(resolve => ctx.signal.addEventListener("abort", resolve, { once: true }));
    return { status: "cancelled", result: "drained" };
  } });`);
  const binding = await f.runtime.activate(f.definition, 1);
  const first = binding!.service.run({ executor: "custom", owner: "alice", requestId: "disable", prepared });
  const second = binding!.service.run({ executor: "custom", owner: "bob", requestId: "sibling", prepared });
  while ((await f.client.listTurns()).turns.filter(turn => turn.status === "running").length < 2) await new Promise(resolve => setTimeout(resolve, 5));
  await binding!.dispose("disable");
  expect(await first).toMatchObject({ status: "cancelled", result: "drained" });
  expect(await second).toMatchObject({ status: "cancelled", result: "drained" });
  expect(await f.client.call("executor.list")).toEqual({ executors: [] });
  const afterUpgrade = await f.runtime.activate(f.definition, 2);
  const third = afterUpgrade!.service.run({ executor: "custom", owner: "alice", requestId: "upgrade", prepared });
  while ((await f.client.listTurns()).turns.filter(turn => turn.status === "running").length < 1) await new Promise(resolve => setTimeout(resolve, 5));
  await afterUpgrade!.dispose("upgrade");
  expect(await third).toMatchObject({ status: "cancelled" });
});

it("binds each lease to the channel-declared host methods only (tasks 2.4/3.2)", async () => {
  const f = await fixture(`export const createExecutor = () => ({ id: "custom", kind: "agent", async run(_input, ctx) {
    const value = await ctx.host.call("connection.get");
    return { status: "succeeded", result: value };
  } });`);
  const binding = await f.runtime.activate(f.definition, 1);
  const input = { executor: "custom", owner: "alice", requestId: "methods", prepared, hostMethods: ["connection.get", "connection.credential"] as const, hostCall: async () => "ok" };
  expect(await binding!.service.run(input)).toMatchObject({ status: "succeeded" });
  expect(f.leases).toEqual([{ turnId: expect.any(String), requestId: "methods", owner: "alice", methods: ["connection.get", "connection.credential"] }]);
  // 接管复跑同一回合时，lease 仍只声明同一组方法，不扩大范围。
  await binding!.service.run({ ...input, since: 0 });
  expect(f.leases).toHaveLength(2);
  expect(f.leases[1]).toEqual(f.leases[0]);
  await binding!.dispose();
});

it("resolves mcpEndpoint dynamically after activation when host binds a random loopback port later", async () => {
  const f = await fixture(`export const createExecutor = () => ({ id: "custom", kind: "agent", async run() { return { status: "succeeded" }; } });`);
  let currentUrl = "http://127.0.0.1:5180/mcp/model-canvas";
  const runtime = createExtensionExecutorRuntime({
    socketPath: f.daemon.socketPath,
    token: "daemon",
    workspaceKey: "test",
    executor: "",
    bridge: { socketPath: path.join(f.dir, "host.sock"), token: "host", workspaceKey: "test" },
    get mcpEndpoint() { return currentUrl; },
    hostCalls: { registerCall() { return { leaseId: "1", release() {} }; } }
  });
  const binding = await runtime.activate(f.definition, 1);
  cleanup.push(() => binding!.dispose());
  expect(runtime.optionsFor("external-extension", 1, "custom")?.mcpEndpoint).toBe("http://127.0.0.1:5180/mcp/model-canvas");
  currentUrl = "http://127.0.0.1:54356/mcp/model-canvas";
  const resolved = runtime.optionsFor("external-extension", 1, "custom");
  expect(resolved?.mcpEndpoint).toBe("http://127.0.0.1:54356/mcp/model-canvas");
  currentUrl = "http://127.0.0.1:59388/mcp/model-canvas";
  expect(resolved?.mcpEndpoint).toBe("http://127.0.0.1:59388/mcp/model-canvas");
});
