import type { IncomingMessage, ServerResponse } from "node:http";
import { getRuntimeComponentManager } from "@woohaa3/runtime-components";
import { createOriginGuard } from "../http/origin-guard.js";

type Manager = NonNullable<ReturnType<typeof getRuntimeComponentManager>>;
const PREFIX = "/api/runtime-components";

/** Installs outlive HTTP requests; cancelling is always an explicit action. */
export function createRuntimeComponentsHandler(options: { getManager?: () => Manager | undefined; allowedOrigins?: readonly string[] } = {}) {
  const installs = new Map<string, AbortController>();
  const originGuard = createOriginGuard(options.allowedOrigins);
  const getManager = options.getManager ?? getRuntimeComponentManager;
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return false;
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(value));
    };
    const remote = req.socket.remoteAddress;
    if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
      send(403, { message: "运行时组件仅允许本机访问" }); return true;
    }
    const origin = originGuard(req);
    if (!origin.ok) { send(403, { message: origin.message }); return true; }
    const manager = getManager();
    if (!manager) { send(req.method === "GET" ? 200 : 409, { available: false, installEnabled: false, components: [], message: "管理员未启用运行时安装" }); return true; }
    try {
      if (pathname === PREFIX && req.method === "GET") {
        send(200, { available: true, ...(manager.policy ? { policy: manager.policy() } : {}), components: await manager.list(), configPath: manager.configPath });
        return true;
      }
      const match = /^\/api\/runtime-components\/([a-z0-9-]+)\/(install|cancel|configure|remove|discover)$/.exec(pathname);
      if (!match || req.method !== "POST") { send(405, { message: "不支持的组件操作" }); return true; }
      const [, id, action] = match as unknown as [string, string, string];
      // Validate id against the lock before creating background state.
      await manager.inspect(id);
      const readBody = async (): Promise<string | null> => {
        let value = "";
        for await (const chunk of req) {
          value += String(chunk);
          if (Buffer.byteLength(value) > 8192) return null;
        }
        return value;
      };
      if (action === "install") {
        if (!installs.has(id)) {
          const controller = new AbortController();
          installs.set(id, controller);
          void manager.install(id, { signal: controller.signal }).catch(() => undefined).finally(() => installs.delete(id));
        }
        send(202, { ok: true });
      } else if (action === "cancel") {
        installs.get(id)?.abort();
        send(200, { ok: true });
      } else if (action === "configure") {
        const configured = await readBody();
        if (configured === null) { send(413, { message: "配置内容过大" }); return true; }
        const value = JSON.parse(configured) as { source?: unknown; path?: unknown };
        if (!["managed", "npm-registry", "local"].includes(String(value.source)) || (value.path !== undefined && typeof value.path !== "string")) {
          send(400, { message: "请选择 npm registry、托管下载或本机程序" }); return true;
        }
        await manager.configure(id, { source: value.source as "managed" | "npm-registry" | "local", ...(typeof value.path === "string" ? { path: value.path } : {}) });
        send(200, { ok: true });
      } else if (action === "remove") {
        await manager.remove(id);
        send(200, { ok: true });
      } else if (action === "discover") {
        // `selected` explains why an explicitly requested path is unusable (for example an npm shim
        // while PATH has no `node`); discovery alone only reports working candidates.
        const requested = await readBody();
        if (requested === null) { send(413, { message: "配置内容过大" }); return true; }
        const path = requested.trim() ? (JSON.parse(requested) as { path?: unknown }).path : undefined;
        const state = typeof path === "string" && path.trim() ? await manager.diagnose(id, path.trim()) : undefined;
        send(200, { candidates: await manager.discoverLocal(id), ...(state && "error" in state ? { selected: { path, error: state.error } } : {}) });
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      send(code === "COMPONENT_IN_USE" || code === "COMPONENT_BUSY" ? 409 : 400, { code, message: error instanceof Error ? error.message : "组件操作失败" });
    }
    return true;
  };
}
