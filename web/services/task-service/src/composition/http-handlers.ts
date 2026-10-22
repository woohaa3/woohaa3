/**
 * Task Service composition：HTTP health/catalog 路由与状态映射
 * （自 `composition.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R10）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CanvasTaskCatalog, TaskExecutionState } from "@woohaa3/contracts";

export function mapWorkerStatus(status: string | undefined): TaskExecutionState {
  return recordState(status);
}

export function recordState(status: string | undefined): TaskExecutionState {
  switch (status) {
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "executing":
      return "running";
    case "queued":
    case "submitting":
      return "queued";
    default:
      return "pending";
  }
}

export function unavailableCatalog(reason: string): CanvasTaskCatalog {
  return { available: false, reason, models: [], defaultModels: {} };
}

/** 同源 catalog 只读路由（任务 4.6）。 */
export function createCatalogHandler(
  resolveCatalog: () => Promise<CanvasTaskCatalog>,
  logger?: (event: Record<string, unknown>) => void
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/api/pptask/catalog" || req.method !== "GET") return false;
    const catalog = await resolveCatalog();
    // 目录已成功读取；缺少 Provider 凭据是目录内容状态，不是 HTTP 服务失败。
    logger?.({ event: "task-catalog", status: 200 });
    sendJson(res, 200, catalog);
    return true;
  };
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
  res.end(payload);
}

/**
 * Task Service liveness/readiness（任务 7.3）。
 */
export function createHealthHandler(
  readiness: () => Promise<{ ready: boolean; reason?: string }>,
  logger?: (event: Record<string, unknown>) => void
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/api/pptask/health/live" && req.method === "GET") {
      sendJson(res, 200, { status: "ok" });
      return true;
    }
    if (pathname === "/api/pptask/health/ready" && req.method === "GET") {
      const result = await readiness();
      logger?.({ event: "task-ready", status: result.ready ? 200 : 503 });
      sendJson(res, result.ready ? 200 : 503, result.ready ? { status: "ready" } : { status: "not-ready", reason: result.reason });
      return true;
    }
    return false;
  };
}
