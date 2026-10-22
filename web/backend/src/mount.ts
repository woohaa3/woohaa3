/**
 * 后端直接端口的公开挂载边界
 * （change: 2026-10-15-support-configurable-app-base-path，design D4）。
 *
 * 直接后端端口（`server.ts`）与生产/组合入口使用同一匹配规则：按完整路径段在一个边界剥离
 * 一次前缀，前缀外请求不进入业务，无尾斜杠入口 GET/HEAD 以 308 跳到规范入口并保留 query。
 * WebSocket upgrade 使用同一匹配，但不依赖重定向。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { decideAppPathMount, normalizeAppBasePath } from "@woohaa3/contracts";

/** 从环境解析并规范化挂载路径；非法配置返回 error（调用方应在监听前失败）。 */
export function resolveBasePathFromEnv(env: Record<string, string | undefined>): {
  basePath: string;
  error?: string;
} {
  const result = normalizeAppBasePath(env.WOOHAA3_BASE_PATH);
  return result.ok ? { basePath: result.basePath } : { basePath: "/", error: result.error };
}

/**
 * 对 HTTP 请求应用挂载边界。返回 true 表示已写出响应（重定向/拒绝），调用方必须停止。
 * `forward` 时 `req.url` 已被改写为应用逻辑路径。
 */
export function applyHttpMount(basePath: string, req: IncomingMessage, res: ServerResponse): boolean {
  const decision = decideAppPathMount(basePath, req.url);
  if (decision.action === "forward") {
    req.url = decision.url;
    return false;
  }
  if (decision.action === "redirect") {
    res.writeHead(308, { location: decision.location, "content-length": "0" });
    res.end();
    return true;
  }
  const status = decision.action === "invalid" ? 400 : 404;
  const body = status === 400 ? "invalid request path" : "not found";
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(Buffer.byteLength(body))
  });
  res.end(body);
  return true;
}

/** 对 WebSocket upgrade 应用挂载边界。返回 true 表示请求已被改写为逻辑路径。 */
export function applyUpgradeMount(basePath: string, req: IncomingMessage): boolean {
  const decision = decideAppPathMount(basePath, req.url);
  if (decision.action === "forward") {
    req.url = decision.url;
    return true;
  }
  return false;
}
