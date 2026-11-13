/**
 * 执行运行时客户端错误语义：领域码必须跨 RPC 保留，通道失败要和领域拒绝分开。
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createExecutorClient } from "../src/client.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function replyServer(response: Record<string, unknown>): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa3-executor-client-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socketPath = path.join(dir, "host.sock");
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", () => socket.end(`${JSON.stringify(response)}\n`));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return socketPath;
}

it("restores a host domain error code", async () => {
  const socketPath = await replyServer({ id: 1, ok: false, error: "导演区不存在", code: "outside-scope" });
  const client = createExecutorClient({ socketPath, token: "t", workspaceKey: "ws", transportErrorCode: "host-bridge-unavailable" });
  await expect(client.call("extension.call")).rejects.toMatchObject({ code: "outside-scope", message: "导演区不存在" });
});

it("tags connection failures so they are not reported as target rejections", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa3-executor-client-missing-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = createExecutorClient({
    socketPath: path.join(dir, "missing.sock"),
    token: "t",
    workspaceKey: "ws",
    transportErrorCode: "host-bridge-unavailable"
  });
  await expect(client.call("extension.call")).rejects.toMatchObject({ code: "host-bridge-unavailable" });
});
