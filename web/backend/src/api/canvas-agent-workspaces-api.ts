import type { IncomingMessage, ServerResponse } from "node:http";
import { APPLICATION_EXTENSION_LOAD_ACTION } from "@woohaa3/contracts";
import type { CanvasAgentWorkspaceService } from "@woohaa3/application-service";
import { authorizeAdmin, type AdminAuthDependencies } from "./admin-auth.js";

export function createCanvasAgentWorkspacesApi(deps: AdminAuthDependencies & {
  workspace: () => CanvasAgentWorkspaceService | null;
  instanceOwner: string;
  authorizeCanvas: (owner: string, canvasId: string) => Promise<boolean>;
}) {
  const base = "/api/settings/agent-workspaces";
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return false;
    const send = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); return true; };
    const workspace = deps.workspace();
    if (!workspace) return send(403, { code: "workspace-unavailable", message: "当前宿主未开放 Tauri 助手工作目录" });
    const auth = await authorizeAdmin(req, deps, APPLICATION_EXTENSION_LOAD_ACTION);
    if (!auth.ok) return send(auth.status, { code: auth.code, message: "需要设置管理权限" });
    const owner = auth.principal?.subject ?? deps.instanceOwner;
    try {
      if (req.method === "GET" && url.pathname === base) return send(200, await workspace.settings());
      if (req.method === "GET" && url.pathname === `${base}/location`) {
        const canvasId = url.searchParams.get("canvasId") ?? "";
        if (!canvasId || !(await deps.authorizeCanvas(owner, canvasId))) return send(403, { code: "workspace-forbidden", message: "无权访问该画布目录" });
        return send(200, { path: await workspace.location({ owner, canvasId }) });
      }
      if (req.method !== "POST") return send(405, { code: "unsupported", message: "不支持此操作" });
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) return send(413, { code: "malformed-request", message: "请求过大" }); chunks.push(Buffer.from(chunk)); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("请求必须为对象");
      const fields = (names: string[]) => { if (Object.keys(body).some(key => !names.includes(key))) throw new Error("请求包含未知字段"); };
      if (url.pathname === `${base}/migrate`) {
        fields(["operationId", "targetPath", "expectedRootRevision"]);
        if (typeof body.operationId !== "string" || typeof body.targetPath !== "string" || !Number.isSafeInteger(body.expectedRootRevision)) throw new Error("迁移请求缺少操作身份、目录或根位置版本");
        return send(202, await workspace.migrate(body as { operationId: string; targetPath: string; expectedRootRevision: number }));
      }
      if (url.pathname === `${base}/cancel-migration`) {
        fields(["operationId"]); if (typeof body.operationId !== "string" || !body.operationId) throw new Error("缺少迁移身份");
        return send(200, await workspace.cancelMigration(body.operationId));
      }
      if (url.pathname === `${base}/clean`) {
        fields(["canvasId"]);
        if (typeof body.canvasId !== "string" || !(await deps.authorizeCanvas(owner, body.canvasId))) return send(403, { code: "workspace-forbidden", message: "无权清理该画布目录" });
        return send(200, await workspace.clean({ owner, canvasId: body.canvasId }));
      }
      return send(404, { code: "not-found", message: "操作不存在" });
    } catch (error) {
      const code = (error as { code?: string }).code ?? "malformed-request";
      return send(code === "workspace-conflict" || code === "workspace-migrating" ? 409 : code === "workspace-forbidden" ? 403 : 400, { code, message: error instanceof Error ? error.message : String(error) });
    }
  };
}
