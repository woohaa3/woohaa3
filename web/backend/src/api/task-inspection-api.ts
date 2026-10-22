/** 内置任务监控只读 API，认证和 tasks.inspect 检查先于任务查询。 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { isJsonObject, parseTaskHistoryQuery, TASKS_INSPECT_ACTION, type AccessRuntime, type TaskInspectionFacade } from "@woohaa3/contracts";
import { statusForAccessError, type AccessEnforcer, type ApplicationRequestAuthenticator } from "@woohaa3/application-service";

export function createTaskInspectionApi(deps: {
  /** 缺省按受控身份处理；本地单实例显式 `enabled:false` 时跳过认证/action。 */
  accessRuntime?: AccessRuntime;
  authenticator: ApplicationRequestAuthenticator;
  accessEnforcer: AccessEnforcer;
  inspection: TaskInspectionFacade;
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
        send(detail ? 200 : 404, detail ?? { code: "not-found", message: "任务不存在或已超过保留期" });
      }
    } catch (error) {
      const status = statusForAccessError(error) ?? 500;
      send(status, { code: status === 403 ? "forbidden" : "unavailable", message: status === 403 ? "没有任务监控权限" : "任务监控暂不可用" });
    }
    return true;
  };
}
