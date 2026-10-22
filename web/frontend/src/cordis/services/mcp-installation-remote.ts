import { MCP_INSTALLATION_PATH, type McpInstallClientId, type McpInstallationResult, type McpInstallationStatus } from "@woohaa3/contracts";
import { createApplicationTransport } from "./application-remote.js";
import type { ApplicationRemoteTransport } from "../contract/remote.js";
import type { AgentConversationResult } from "./agent-conversation-remote.js";

export function createMcpInstallationRemote(transport: ApplicationRemoteTransport = createApplicationTransport()) {
  async function request<T>(method: "GET" | "POST", suffix = ""): Promise<AgentConversationResult<T>> {
    const result = await transport.request({ path: `${MCP_INSTALLATION_PATH}${suffix}`, method, ...(method === "POST" ? { body: {} } : {}) });
    return result.ok ? { ok: true, value: result.data as T } : { ok: false, code: result.code ?? "unavailable", error: result.error };
  }
  return {
    detect: () => request<McpInstallationStatus>("GET"),
    /** 只提交注册表内的客户端 id 与目标 key；路径与地址由宿主派生。 */
    install: (id: McpInstallClientId, targetKey = "default") =>
      request<McpInstallationResult>("POST", `/${encodeURIComponent(id)}/${encodeURIComponent(targetKey)}`)
  };
}
export type McpInstallationRemote = ReturnType<typeof createMcpInstallationRemote>;
