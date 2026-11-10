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
