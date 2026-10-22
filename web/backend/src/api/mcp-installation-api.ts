import type { IncomingMessage, ServerResponse } from "node:http";
import { APPLICATION_EXTENSION_LOAD_ACTION, MCP_INSTALLATION_PATH, type McpInstallClientId } from "@woohaa3/contracts";
import { authorizeAdmin, type AdminAuthDependencies } from "./admin-auth.js";
import { findClient } from "../mcp-installation/clients/registry.js";
import { InstallationError, type createMcpInstaller } from "../mcp-installation/service.js";

/** 只解析注册表内的 id 与目标 key；浏览器仍不能提交路径、命令或 URL。 */
function parseRoute(pathname: string): { id: McpInstallClientId; targetKey: string } | null {
  if (!pathname.startsWith(`${MCP_INSTALLATION_PATH}/`)) return null;
  const [rawId, rawTarget, ...rest] = pathname.slice(MCP_INSTALLATION_PATH.length + 1).split("/");
  if (!rawId || rest.length) return null;
  const spec = findClient(decodeURIComponent(rawId));
  if (!spec) return null;
  const targetKey = rawTarget ? decodeURIComponent(rawTarget) : "default";
  return { id: spec.id, targetKey };
}

export function createMcpInstallationApi(deps: AdminAuthDependencies & { installer: ReturnType<typeof createMcpInstaller>; basePath: string }) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== MCP_INSTALLATION_PATH && !pathname.startsWith(`${MCP_INSTALLATION_PATH}/`)) return false;
    const send = (status: number, body: unknown) => { res.statusCode = status; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(body)); return true; };
    const route = parseRoute(pathname);
    if (!((req.method === "GET" && pathname === MCP_INSTALLATION_PATH) || (req.method === "POST" && route))) return send(405, { message: "不支持的客户端或操作" });
    const auth = await authorizeAdmin(req, deps, APPLICATION_EXTENSION_LOAD_ACTION);
    if (!auth.ok) return send(auth.status, { code: auth.code, message: "需要站点管理员授权才能访问本机客户端配置" });
    // 浏览器显式点击安装；公开地址由请求公开 Origin + 部署挂载派生，绝不接收客户端路径/命令/URL。
    let origin: string;
    try {
      const publicHost = req.headers["x-forwarded-host"] ?? req.headers.host;
      const protocol = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
      const url = new URL(req.headers.origin || `${protocol}://${publicHost}`);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
      origin = url.origin;
    } catch { return send(400, { message: "无法确定应用公开地址，请从应用页面重试" }); }
    const url = `${origin}${deps.basePath}mcp/model-canvas`;
    try {
      return send(200, req.method === "GET" ? await deps.installer.detect(url) : await deps.installer.install(route!.id, url, route!.targetKey));
    } catch (error) {
      if (error instanceof InstallationError && error.code === "target-not-found") return send(404, { message: error.message });
      return send(409, { message: error instanceof InstallationError ? error.message : "无法写入客户端配置，请检查文件权限后重试" });
    }
  };
}
