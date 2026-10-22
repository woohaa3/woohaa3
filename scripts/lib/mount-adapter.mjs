/**
 * 公开挂载边界适配器（change: 2026-10-15-support-configurable-app-base-path，design D4）。
 *
 * 生产服务（`scripts/serve-web.mjs`）、组合入口（`scripts/dev-orchestrator.mjs`）、E2E 宿主
 * （`web/e2e/server.mjs`）与直接后端端口（`web/backend/src/server.ts` 的等价逻辑）共用同一
 * 规则：只在**一个**公开边界按完整路径段匹配并剥离一次前缀，前缀外请求不进入应用业务或
 * SPA 回退。HTTP 与 WS 使用相同匹配；WS 不进行无尾斜杠重定向。
 *
 * 决策行为来自 contracts 的 `decideAppPathMount`（唯一来源）。
 */
import { decideAppPathMount } from "../../web/contracts/src/base-path/app-base-path.mjs";

/**
 * 对 HTTP 请求应用挂载边界。返回动作；`forward` 时已把 `req.url` 改写为应用逻辑路径。
 */
export function applyHttpMount(basePath, req) {
  const decision = decideAppPathMount(basePath, req.url);
  if (decision.action === "forward") {
    req.url = decision.url;
    return { kind: "forward" };
  }
  if (decision.action === "redirect") return { kind: "redirect", location: decision.location };
  if (decision.action === "invalid") return { kind: "invalid" };
  return { kind: "outside" };
}

/**
 * 对 WebSocket upgrade 应用挂载边界。返回动作；`forward` 时已改写 `req.url`。
 * 无尾斜杠入口不重定向（WS MUST NOT 依赖重定向），按前缀外处理。
 */
export function applyUpgradeMount(basePath, req) {
  const decision = decideAppPathMount(basePath, req.url);
  if (decision.action === "forward") {
    req.url = decision.url;
    return { kind: "forward" };
  }
  if (decision.action === "invalid") return { kind: "invalid" };
  return { kind: "outside" };
}

/**
 * 写出边界拒绝/重定向响应；返回 true 表示请求已由边界处理，调用方必须停止。
 * 仅用于 HTTP（WS upgrade 用 `rejectUpgrade`）。
 */
export function interceptHttpMount(req, res, action) {
  if (action.kind === "forward") return false;
  if (action.kind === "redirect") {
    res.writeHead(308, { location: action.location, "content-length": "0" });
    res.end();
    return true;
  }
  const status = action.kind === "invalid" ? 400 : 404;
  const body = status === 400 ? "invalid request path" : "not found";
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(Buffer.byteLength(body))
  });
  res.end(body);
  return true;
}

/** 拒绝（并关闭）一个 upgrade socket。 */
export function rejectUpgradeSocket(socket) {
  socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  socket.destroy();
}
