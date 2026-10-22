/**
 * 外部 MCP 客户端接入端点（同源 Streamable HTTP）。
 *
 * 纯派生：只把同源 `/mcp/*` 端点渲染成可填入 MCP 客户端配置的地址。
 * 不写规范状态、不发起请求；模型面板与右下角控件面板共用同一派生，避免多处字面量漂移。
 */
export const MODEL_MCP_HTTP_PATH = "/mcp/model-canvas";

import { appPublicUrl } from "./services/app-base-path.js";

/** 生产用同源绝对地址；SSR / 测试无 `window` 时降级为相对路径。 */
export function resolveModelMcpServerUrl(): string {
  const path = appPublicUrl(MODEL_MCP_HTTP_PATH);
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
}
