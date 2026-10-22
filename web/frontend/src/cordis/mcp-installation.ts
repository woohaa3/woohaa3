import { resolveModelMcpServerUrl } from "./mcp-endpoint.js";
import { MCP_HINT_INSTALL_COPY_PREFIX } from "./mcp-hint.js";

/** Presentation only: never runs commands or reads/writes client configuration. */
export function mcpInstallation(serverUrl = resolveModelMcpServerUrl()) {
  return {
    instructions: "将以下指引交给客户端中的助手，或在客户端的 MCP 设置中添加 Streamable HTTP 服务。",
    content: `${MCP_HINT_INSTALL_COPY_PREFIX}${serverUrl}`,
    action: "复制安装指引",
  };
}
