import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRuntimeBridge } from "./agent-runtime-bridge.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function call(socketPath: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ id: 1, ...request })}\n`));
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      for (const line of buffer.split(/\r?\n/)) {
        if (!line) continue;
        const value = JSON.parse(line) as Record<string, unknown>;
        socket.destroy();
        resolve(value);
        return;
      }
    });
    socket.once("error", reject);
  });
}

describe("Agent runtime host bridge", () => {
  it("校验身份并按白名单回调工具/画布/媒体", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa3-bridge-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const socketPath = path.join(dir, "bridge.sock");
    const tools = {
      issue: vi.fn(async () => ({ token: "grant-1", canvasIds: ["c"], nodeIds: ["n"], tools: ["get_model_node"], workId: "w" })),
      revoke: vi.fn(),
      authorize: vi.fn(() => ({ ok: true as const }))
    };
    const bridge = await createAgentRuntimeBridge({
      socketPath,
      token: "secret",
      workspaceKey: "ws",
      tools: tools as never,
      canvasRead: async () => ({ canvasId: "c" } as never),
      mediaRead: async () => ({ bytes: Uint8Array.from([1, 2, 3]), contentType: "image/png" })
    });
    cleanups.push(() => bridge.close());

    const rejected = await call(socketPath, { id: 1, token: "bad", workspaceKey: "ws", method: "canvas.read", params: { subject: "u", canvasId: "c" } });
    expect(rejected).toMatchObject({ ok: false });

    const grant = await call(socketPath, { id: 2, token: "secret", workspaceKey: "ws", method: "tools.issue", params: { workId: "w", canvasId: "c", nodeId: "n", mode: "model3d", tools: ["get_model_node"] } });
    expect(grant).toMatchObject({ ok: true, result: { token: "grant-1" } });
    expect(tools.issue).toHaveBeenCalledTimes(1);

    const media = await call(socketPath, { id: 3, token: "secret", workspaceKey: "ws", method: "media.read", params: { storageKey: "k", canvasId: "c" } });
    expect(media).toMatchObject({ ok: true, result: { contentType: "image/png", bytes: Buffer.from([1, 2, 3]).toString("base64") } });

    const lease = bridge.registerCall(async (method, params) => {
      if (method !== "connection.read") throw new Error("method denied");
      return { owner: "bound-owner", params };
    });
    const invoke = () => call(socketPath, { token: "secret", workspaceKey: "ws", method: "extension.call", params: { leaseId: lease.leaseId, method: "connection.read", params: { id: 1 } } });
    expect(await invoke()).toMatchObject({ ok: true, result: { owner: "bound-owner" } });
    lease.release();
    expect(await invoke()).toMatchObject({ ok: false, error: expect.stringContaining("lease") });

    const unknown = await call(socketPath, { id: 4, token: "secret", workspaceKey: "ws", method: "shell.exec", params: {} });
    expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining("未知 Host bridge 方法") });
  });
});

describe("Host bridge turn leases across host restarts (task 2.3)", () => {
  const authorities = new Map<string, import("./agent-runtime-bridge.js").BridgeTurnAuthority>();
  const authority = (overrides: Partial<import("./agent-runtime-bridge.js").BridgeTurnAuthority> = {}) => ({
    turnId: "turn-1",
    requestId: "req-1",
    owner: "alice",
    canvasId: "canvas",
    hostMethods: ["connection.get", "connection.credential"],
    configRevision: 2,
    credentialEpoch: 3,
    expiresAt: null,
    revokedAt: null,
    ...overrides
  });

  async function bridgeFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa3-bridge-lease-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const socketPath = path.join(dir, "bridge.sock");
    const tools = { issue: vi.fn(), revoke: vi.fn(), authorize: vi.fn(() => ({ ok: true as const })) };
    const create = async () => {
      const bridge = await createAgentRuntimeBridge({
        socketPath,
        token: "boot-token",
        workspaceKey: "ws",
        runtimeDir: dir,
        tools: tools as never,
        canvasRead: async () => ({ canvasId: "c" } as never),
        mediaRead: async () => ({ bytes: Uint8Array.from([]), contentType: "text/plain" })
      });
      bridge.setTurnAuthority((turnId) => authorities.get(turnId) ?? null);
      return { bridge, socketPath };
    };
    return { dir, create };
  }

  it("accepts a lease issued before a restart after adoption rebuilds the handler", async () => {
    const { create } = await bridgeFixture();
    const first = await create();
    const lease = first.bridge.registerCall(async () => ({ from: "first-host" }), {
      turnId: "turn-1", requestId: "req-1", owner: "alice", methods: ["connection.get"], exp: 0
    });
    authorities.set("turn-1", authority());
    await first.bridge.close();

    const second = await create();
    cleanups.push(() => second.bridge.close());
    second.bridge.setAdoptionHandler(async (turnId) => {
      second.bridge.registerCall(async (method) => ({ from: "adopted", method }), {
        turnId, requestId: "req-1", owner: "alice", methods: ["connection.get"], exp: 0
      });
      return true;
    });
    const response = await call(second.socketPath, { token: "boot-token", workspaceKey: "ws", method: "extension.call", params: { leaseId: lease.leaseId, method: "connection.get", params: {} } });
    // 桥 token 与 host key 复用后，旧 daemon 的请求仍被受理（token 为持久 token）。
    expect(response).toMatchObject({ ok: true, result: { from: "adopted", method: "connection.get" } });
  });

  it("执行器派生 turnId 按 requestId 解析到账本授权，并按规范 turnId 接管", async () => {
    const { create } = await bridgeFixture();
    const first = await create();
    // 会话账本里的 turnId 与执行器派生的 lease turnId 不同，但 requestId 相同。
    authorities.set("turn-real", authority({ turnId: "turn-real", requestId: "req-1" }));
    const lease = first.bridge.registerCall(async () => ({ from: "first-host" }), {
      turnId: "5f1c9d-executor-derived", requestId: "req-1", owner: "alice", methods: ["connection.get"], exp: 0
    });
    await first.bridge.close();

    const second = await create();
    cleanups.push(() => second.bridge.close());
    second.bridge.setTurnAuthorityByRequest((owner, requestId) =>
      owner === "alice" && requestId === "req-1" ? authorities.get("turn-real") ?? null : null);
    const adopted: string[] = [];
    second.bridge.setAdoptionHandler(async (turnId) => {
      adopted.push(turnId);
      second.bridge.registerCall(async () => ({ from: "adopted" }), {
        turnId, requestId: "req-1", owner: "alice", methods: ["connection.get"], exp: 0
      });
      return true;
    });
    const response = await call(second.socketPath, { token: "boot-token", workspaceKey: "ws", method: "extension.call", params: { leaseId: lease.leaseId, method: "connection.get", params: {} } });
    expect(response).toMatchObject({ ok: true, result: { from: "adopted" } });
    // 接管按会话账本的 turnId 进行，而不是执行器派生键。
    expect(adopted).toEqual(["turn-real"]);
  });

  it("rejects forged, expired, revoked and wrong-owner leases before side effects", async () => {
    const { create } = await bridgeFixture();
    const { bridge, socketPath } = await create();
    cleanups.push(() => bridge.close());
    const calls: string[] = [];
    authorities.set("turn-1", authority());
    const lease = bridge.registerCall(async (method) => { calls.push(method); return { ok: true }; }, {
      turnId: "turn-1", requestId: "req-1", owner: "alice", methods: ["connection.get"], exp: 0
    });
    const invoke = (leaseId: string, method = "connection.get") => call(socketPath, { token: "boot-token", workspaceKey: "ws", method: "extension.call", params: { leaseId, method, params: {} } });

    // 伪造签名：不改 payload 只改签名。
    const forged = `${lease.leaseId.slice(0, lease.leaseId.lastIndexOf("."))}.AAAA`;
    expect(await invoke(forged)).toMatchObject({ ok: false, error: expect.stringContaining("signature") });
    // 越权方法：authority 未列入。
    expect(await invoke(lease.leaseId, "connection.credential")).toMatchObject({ ok: false, error: expect.stringContaining("not allowed") });
    // 撤销后立即拒绝。
    authorities.set("turn-1", authority({ revokedAt: new Date().toISOString() }));
    expect(await invoke(lease.leaseId)).toMatchObject({ ok: false, error: expect.stringContaining("revoked") });
    // owner 不匹配。
    authorities.set("turn-1", authority({ owner: "mallory" }));
    expect(await invoke(lease.leaseId)).toMatchObject({ ok: false, error: expect.stringContaining("owner mismatch") });
    // 过期 lease。
    authorities.set("turn-1", authority());
    const expired = bridge.registerCall(async () => ({ ok: true }), {
      turnId: "turn-1", requestId: "req-1", owner: "alice", methods: ["connection.get"], exp: 1
    });
    expect(await invoke(expired.leaseId)).toMatchObject({ ok: false, error: expect.stringContaining("expired") });
    expect(calls).toEqual([]);
  });
});

describe("host-call reconstruction through a restarted bridge (task 2.4)", () => {
  it("keeps serving an in-flight executor turn with the persisted bridge identity and turn authority", async () => {
    const { startExecutorDaemon } = await import("../../../../../packages/execution-runtime/src/daemon.js");
    const { createExecutorClient } = await import("../../../../../packages/execution-runtime/src/client.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa3-bridge-adopt-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const modulePath = path.join(dir, "executor.mjs");
    fs.writeFileSync(modulePath, `export const createExecutor = () => ({ id: "custom", kind: "agent", async run(_input, ctx) {
      const first = await ctx.host.call("connection.get");
      await new Promise(resolve => setTimeout(resolve, 150));
      const second = await ctx.host.call("connection.get");
      return { status: "succeeded", result: { first, second } };
    } });`);
    const daemon = await startExecutorDaemon({
      socketPath: path.join(dir, "executor.sock"),
      stateDir: dir,
      token: "daemon-token",
      workspaceKey: "ws"
    });
    cleanups.push(() => daemon.close());
    const client = createExecutorClient({ socketPath: daemon.socketPath, token: "daemon-token", workspaceKey: "ws" });
    await client.call("executor.register", { registrationId: "ext", modules: [{ id: "custom", module: modulePath, export: "createExecutor" }] });

    const turnAuthority = {
      turnId: "turn-adopt", requestId: "req-adopt", owner: "alice", canvasId: "canvas",
      hostMethods: ["connection.get"], configRevision: 1, credentialEpoch: 1, expiresAt: null, revokedAt: null
    };
    const tools = { issue: vi.fn(), revoke: vi.fn(), authorize: vi.fn(() => ({ ok: true as const })) };
    const makeBridge = async () => {
      const bridge = await createAgentRuntimeBridge({
        socketPath: path.join(dir, "bridge.sock"),
        token: "boot-token",
        workspaceKey: "ws",
        runtimeDir: dir,
        tools: tools as never,
        canvasRead: async () => ({ canvasId: "canvas" } as never),
        mediaRead: async () => ({ bytes: Uint8Array.from([]), contentType: "text/plain" })
      });
      bridge.setTurnAuthority((turnId) => turnId === turnAuthority.turnId ? turnAuthority : null);
      return bridge;
    };
    const first = await makeBridge();
    const lease = first.registerCall(async () => "first-host", {
      turnId: turnAuthority.turnId, requestId: turnAuthority.requestId, owner: turnAuthority.owner, methods: turnAuthority.hostMethods, exp: 0
    });
    await client.runTurn({
      turnId: turnAuthority.turnId, requestId: turnAuthority.requestId, kind: "agent", executor: "ext/custom",
      prepared: { preparedHash: "h" } as never,
      host: { socketPath: first.socketPath, token: first.token, workspaceKey: "ws", leaseId: lease.leaseId }
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await first.close();

    const second = await makeBridge();
    cleanups.push(() => second.close());
    second.setAdoptionHandler(async (turnId) => {
      second.registerCall(async () => "second-host", {
        turnId, requestId: turnAuthority.requestId, owner: turnAuthority.owner, methods: turnAuthority.hostMethods, exp: 0
      });
      return true;
    });
    const deadline = Date.now() + 5_000;
    let view = await client.queryTurn(turnAuthority.turnId);
    while ((view?.status === "queued" || view?.status === "running") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      view = await client.queryTurn(turnAuthority.turnId);
    }
    expect(view).toMatchObject({ status: "succeeded", result: { first: "first-host", second: "second-host" } });
  });
});
