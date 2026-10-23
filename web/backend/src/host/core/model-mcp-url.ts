/**
 * 内部受控 MCP endpoint 的派生
 * （change: 2026-10-17-add-agent-appserver-and-sdk-connections）。
 *
 * 本机 Agent 进程经回环直连本后端，但后端仍按 `WOOHAA3_BASE_PATH` 挂载所有 HTTP 路由。
 * 因此不能固定使用根路径：开发子路径（如 `/dev/<id>/`）必须保留前缀，否则 MCP 会收到 404，
 * Codex 侧表现为“没有工具”而只做纯文本回答。
 */

/** 规范化 basePath 前缀：根路径为空，其余保证单个前导斜杠并去掉末尾斜杠。 */
function basePathPrefix(basePath: string): string {
  const trimmed = basePath.trim().replace(/\/+$/, "");
  if (trimmed === "" || trimmed === "/") return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** 本进程内受控 MCP 工具入口（回环 HTTP；包含当前应用挂载前缀）。 */
export function internalModelMcpUrl(input: { port: string | number; basePath: string }): string {
  const port = String(input.port).trim() || "5180";
  return `http://127.0.0.1:${port}${basePathPrefix(input.basePath)}/mcp/model-canvas`;
}

/**
 * 给本机 Agent 的受控 MCP 入口。url 在每次读取时从 env 派生，
 * 避免桌面宿主先装配插件、后绑定随机/开发端口时把 5180 拍死。
 */
export function internalModelMcpEndpoint(
  env: { BACKEND_PORT?: string; PORT?: string },
  basePath: string
): { name: "woohaa"; readonly url: string } {
  return {
    name: "woohaa",
    get url() {
      return internalModelMcpUrl({
        port: env.BACKEND_PORT ?? env.PORT ?? "5180",
        basePath
      });
    }
  };
}
