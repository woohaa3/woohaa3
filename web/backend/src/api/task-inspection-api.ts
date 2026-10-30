/** 内置任务监控只读 API，认证和 tasks.inspect 检查先于任务查询。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isJsonObject,
  parseTaskHistoryQuery,
  TASKS_INSPECT_ACTION,
  type AccessRuntime,
  type TaskInspectionFacade,
  type TaskResultLocation,
  type TaskResultSummary
} from "@woohaa3/contracts";
import { statusForAccessError, type AccessEnforcer, type ApplicationRequestAuthenticator } from "@woohaa3/application-service";

/**
 * 给详情补上产物的当前位置。
 *
 * 位置是**读取时**的事实（画布归属、主存储都可能已经变过），所以不落库、只在返回前算一次；
 * 解析失败一律降级为「没有位置」——排障面板不能因为定位失败而整个打不开。
 */
async function withLocation<T extends { result?: TaskResultSummary }>(
  detail: T | null,
  locate: ((input: { storageKey: string; canvasId?: string }) => Promise<TaskResultLocation | null>) | undefined
): Promise<T | null> {
  if (!detail?.result?.storageKey || !locate) return detail;
  const canvasId = (detail as { canvasId?: string }).canvasId;
  try {
    const location = await locate({
      storageKey: detail.result.storageKey,
      ...(canvasId ? { canvasId } : {})
    });
    if (!location) return detail;
    return { ...detail, result: { ...detail.result, location } };
  } catch {
    return detail;
  }
}

export function createTaskInspectionApi(deps: {
  /** 缺省按受控身份处理；本地单实例显式 `enabled:false` 时跳过认证/action。 */
  accessRuntime?: AccessRuntime;
  authenticator: ApplicationRequestAuthenticator;
  accessEnforcer: AccessEnforcer;
  inspection: TaskInspectionFacade;
  /**
   * 解析产物字节当前落在哪个后端（可选）。
   *
   * 只影响展示：拿不到位置时详情照常返回。
   */
  locate?: (input: { storageKey: string; canvasId?: string }) => Promise<TaskResultLocation | null>;
}) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== "/api/task-inspection/snapshot" && path !== "/api/task-inspection/detail") return false;
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "POST") { send(405, { code: "unsupported", message: "仅支持 POST" }); return true; }
    try {
      let principal: Awaited<ReturnType<ApplicationRequestAuthenticator>> = null;
      if (deps.accessRuntime?.enabled !== false) {
        principal = await deps.authenticator(req, "http");
        if (!principal) { send(401, { code: "unauthorized", message: "需要登录" }); return true; }
        await deps.accessEnforcer.assertAction(principal, TASKS_INSPECT_ACTION);
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 65_536) { send(413, { code: "payload-too-large", message: "请求体过大" }); return true; }
        chunks.push(Buffer.from(chunk));
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
      catch { send(400, { code: "malformed-request", message: "请求体不是有效 JSON" }); return true; }
      if (!isJsonObject(body)) { send(400, { code: "malformed-request", message: "请求体必须是对象" }); return true; }
      if (path.endsWith("/snapshot")) {
        const decoded = parseTaskHistoryQuery(isJsonObject(body.query) ? body.query : {});
        if (!decoded.ok) { send(400, decoded); return true; }
        if (body.limit !== undefined && (!Number.isInteger(body.limit) || (body.limit as number) <= 0)) {
          send(400, { code: "malformed-request", message: "limit 必须为正整数" }); return true;
        }
        send(200, await deps.inspection.snapshot({
          ...(principal ? { principal } : {}),
          query: decoded.query,
          ...(typeof body.limit === "number" ? { limit: body.limit } : {})
        }));
      } else {
        const taskKey = typeof body.taskKey === "string" ? body.taskKey.trim() : "";
        if (!taskKey) { send(400, { code: "malformed-request", message: "缺少 taskKey" }); return true; }
        const detail = await deps.inspection.detail({ ...(principal ? { principal } : {}), taskKey });
        const located = await withLocation(detail, deps.locate);
        send(located ? 200 : 404, located ?? { code: "not-found", message: "任务不存在或已超过保留期" });
      }
    } catch (error) {
      const status = statusForAccessError(error) ?? 500;
      send(status, { code: status === 403 ? "forbidden" : "unavailable", message: status === 403 ? "没有任务监控权限" : "任务监控暂不可用" });
    }
    return true;
  };
}
