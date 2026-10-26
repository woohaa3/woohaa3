/**
 * 宿主受控重启入口（change: 2026-10-21-harden-extension-fault-isolation，design D6）。
 *
 * `POST /api/host/restart`，请求体 `{ reason?: string, exitSafeMode?: boolean }`：
 * 1. 管理员授权（具名 action `extensions.configure`，与插件启停同一权限）并写审计日志；
 * 2. 写入 boot-state 的 `restartRequested` 标记（主动重启不计入启动失败次数；`exitSafeMode`
 *    时同时清除安全模式与计数）；
 * 3. 先回 202，响应写完后通知进程入口走与 SIGTERM 相同的排空关闭，最后以退出码 75 退出，
 *    由拉起方（dev 编排 / PM2）重新启动。
 *
 * 排空期间的重复请求幂等：直接回 202，不再写标记、不触发第二次关闭。没有进程入口订阅
 * （嵌入式/测试装配）时回 503，宿主不退出。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { APPLICATION_EXTENSION_LOAD_ACTION, WOOHAA3_PROTOCOL_VERSION } from "@woohaa3/contracts";
import { authorizeAdmin, type AdminAuthDependencies } from "./admin-auth.js";

export const HOST_RESTART_PATH = "/api/host/restart";
/** 退出码 75（EX_TEMPFAIL）：约定为「请求重启」，拉起方据此重新拉起而不是按崩溃处理。 */
export const HOST_RESTART_EXIT_CODE = 75;
const MAX_REASON_LENGTH = 200;

export type HostRestartRequest = { reason: string; exitSafeMode: boolean; actor: string };

export type HostRestartController = {
  /** 进程入口订阅重启请求；返回退订函数。 */
  subscribe(listener: (request: HostRestartRequest) => void): () => void;
  /** 是否已有进程入口订阅（没有则无法真正退出重启）。 */
  supported(): boolean;
  /** 是否已经受理过一次重启请求（排空中）。 */
  requested(): boolean;
  /** 受理一次请求并通知订阅者；重复调用返回 false。 */
  request(request: HostRestartRequest): boolean;
};

export function createHostRestartController(): HostRestartController {
  const listeners = new Set<(request: HostRestartRequest) => void>();
  let pending = false;
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    supported: () => listeners.size > 0,
    requested: () => pending,
    request(request) {
      if (pending) return false;
      pending = true;
      for (const listener of [...listeners]) listener(request);
      return true;
    }
  };
}

export type HostRestartApiDependencies = AdminAuthDependencies & {
  controller: HostRestartController;
  /** 写 boot-state 的 restartRequested 标记；失败只记日志（安全方向：下次启动按一次失败计数）。 */
  markRestartRequested?: (input: { reason: string; exitSafeMode: boolean }) => void;
  logger?: (event: Record<string, unknown>) => void;
};

export function createHostRestartApiHandler(deps: HostRestartApiDependencies): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const log = deps.logger ?? (() => undefined);
  return async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "");
    if (pathname !== HOST_RESTART_PATH) return false;
    if (req.method !== "POST") {
      sendJson(res, 405, { code: "unsupported", message: "仅支持 POST" });
      return true;
    }
    const auth = await authorizeAdmin(req, deps, APPLICATION_EXTENSION_LOAD_ACTION);
    if (!auth.ok) {
      log({ event: "host-restart-unauthorized", status: auth.status });
      sendJson(res, auth.status, { code: auth.code, message: "需要站点管理员授权" });
      return true;
    }
    const body = await readJson(req).catch(() => null) as { reason?: unknown; exitSafeMode?: unknown } | null;
    if (!body || typeof body !== "object" ||
        (body.reason !== undefined && typeof body.reason !== "string") ||
        (body.exitSafeMode !== undefined && typeof body.exitSafeMode !== "boolean")) {
      sendJson(res, 400, { code: "malformed-request", message: "请求体必须是 { reason?: string, exitSafeMode?: boolean }" });
      return true;
    }
    if (deps.controller.requested()) {
      sendJson(res, 202, { status: "draining" });
      return true;
    }
    if (!deps.controller.supported()) {
      sendJson(res, 503, { code: "restart-unsupported", message: "当前宿主进程不支持受控重启" });
      return true;
    }
    const reason = (typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "manual").slice(0, MAX_REASON_LENGTH);
    const exitSafeMode = body.exitSafeMode === true;
    try {
      deps.markRestartRequested?.({ reason, exitSafeMode });
    } catch (error) {
      log({ event: "host-restart-mark-failed", message: error instanceof Error ? error.message : String(error) });
    }
    log({ event: "host-restart-requested", actor: auth.actor, reason, exitSafeMode });
    // 先把 202 写完再触发排空：排空会关闭监听与连接，响应不能被截断。
    res.once("finish", () => deps.controller.request({ reason, exitSafeMode, actor: auth.actor }));
    sendJson(res, 202, { status: "restarting", exitCode: HOST_RESTART_EXIT_CODE });
    return true;
  };
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  const payload = JSON.stringify(status >= 400 ? { ...body, protocolVersion: WOOHAA3_PROTOCOL_VERSION } : body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
  res.end(payload);
}

async function readJson(req: IncomingMessage, maxBytes = 16 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).byteLength;
    if (total > maxBytes) throw new Error("payload-too-large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : JSON.parse(text);
}
