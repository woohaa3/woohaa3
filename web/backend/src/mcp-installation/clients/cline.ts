import path from "node:path";
import type { McpClientSpec } from "./types.js";
import { entry, executable, inHome, target, targets } from "./shared.js";

/**
 * Cline：显式 `streamableHttp`，避免客户端按缺省值落回 SSE。
 * 官方 `cline mcp add --transport http --yes` 写同一份 settings。
 */
export const cline: McpClientSpec = {
  id: "cline",
  label: "Cline",
  group: "editor",
  detect: [executable("cline"), targets],
  async targets({ env, home }) {
    const file = env.CLINE_MCP_SETTINGS_PATH?.trim()
      ? path.resolve(env.CLINE_MCP_SETTINGS_PATH)
      : inHome(home, ".cline", "data", "settings", "cline_mcp_settings.json");
    return [target(file, "json")];
  },
  entry: entry({ container: ["mcpServers"], fields: url => ({ type: "streamableHttp", url }), remoteType: "streamableHttp" }),
  writer: {
    kind: "command",
    names: ["cline"],
    args: url => ["mcp", "add", "--transport", "http", "--yes", "woohaa3-model-canvas", url]
  }
};
