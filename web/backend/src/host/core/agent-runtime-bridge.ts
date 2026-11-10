/**
 * 宿主依赖桥（change: 2026-11-07-add-pluggable-agent-roles）。
 *
 * daemon 里的执行器没有宿主的连接、工具授权和画布/媒体权限；每次回合通过本机 socket 回调
 * 这几个**受控方法**。桥只监听本机、带 workspace token，方法白名单固定。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import type { ApplicationToolDelegationFacade, ServerCanvas } from "@woohaa3/contracts";

export type AgentRuntimeBridgeOptions = {
  socketPath: string;
  token: string;
  workspaceKey: string;
  tools: ApplicationToolDelegationFacade;
  canvasRead(input: { subject: string; canvasId: string }): Promise<ServerCanvas>;
  mediaRead(input: { storageKey: string; canvasId: string }): Promise<{ bytes: Uint8Array; contentType: string }>;
  logger?: (event: Record<string, unknown>) => void;
};

export type AgentRuntimeBridge = {
  socketPath: string;
  registerCall(handler: (method: string, params: unknown) => Promise<unknown>): { leaseId: string; release(): void };
  close(): Promise<void>;
};

function reply(socket: net.Socket, id: number, result: unknown, error?: unknown): void {
  if (socket.destroyed) return;
  const message = error instanceof Error ? error.message : error === undefined ? undefined : String(error);
  socket.write(`${JSON.stringify(error ? { id, ok: false, error: message } : { id, ok: true, result })}\n`);
}

export async function createAgentRuntimeBridge(options: AgentRuntimeBridgeOptions): Promise<AgentRuntimeBridge> {
  const calls = new Map<string, (method: string, params: unknown) => Promise<unknown>>();
  const log = options.logger ?? (() => undefined);
  if (process.platform !== "win32") {
    try { fs.unlinkSync(options.socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  const dispatch = async (request: { id: number; token?: string; workspaceKey?: string; method?: string; params?: unknown }): Promise<unknown> => {
    if (request.token !== options.token || request.workspaceKey !== options.workspaceKey) throw new Error("Host bridge 身份校验失败");
    const params = (request.params ?? {}) as Record<string, unknown>;
    switch (request.method) {
      case "extension.call": {
        const handler = calls.get(String(params.leaseId ?? ""));
        if (!handler) throw new Error("Executor host lease is unavailable");
        return handler(String(params.method ?? ""), params.params);
      }
      case "tools.issue":
        return options.tools.issue(params as never);
      case "tools.revoke":
        options.tools.revoke(String(params.workId ?? ""), { subject: String(params.subject ?? ""), authLevel: "authenticated" });
        return { revoked: true };
      case "tools.authorize":
        return options.tools.authorize(params as never);
      case "canvas.read":
        return options.canvasRead({ subject: String(params.subject ?? ""), canvasId: String(params.canvasId ?? "") });
      case "media.read": {
        const media = await options.mediaRead({ storageKey: String(params.storageKey ?? ""), canvasId: String(params.canvasId ?? "") });
        return { bytes: Buffer.from(media.bytes).toString("base64"), contentType: media.contentType };
      }
      default:
        throw new Error(`未知 Host bridge 方法：${String(request.method)}`);
    }
  };

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let request: { id: number; token?: string; workspaceKey?: string; method?: string; params?: unknown };
        try { request = JSON.parse(line) as typeof request; } catch { continue; }
        void dispatch(request).then(
          (result) => reply(socket, request.id, result),
          (error) => reply(socket, request.id, undefined, error)
        );
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => resolve());
  });
  if (process.platform !== "win32") {
    try { fs.chmodSync(options.socketPath, 0o600); } catch { /* best effort */ }
  }
  log({ event: "agent-runtime-bridge-started", socketPath: options.socketPath });
  return {
    socketPath: options.socketPath,
    registerCall(handler) {
      const leaseId = randomUUID();
      calls.set(leaseId, handler);
      return { leaseId, release: () => { calls.delete(leaseId); } };
    },
    close: async () => {
      calls.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") {
        try { fs.unlinkSync(options.socketPath); } catch { /* gone */ }
      }
    }
  };
}
