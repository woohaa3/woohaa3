import path from "node:path";
import type { McpClientSpec } from "./types.js";
import { entry, files, inHome, target, targets } from "./shared.js";

/**
 * Kimi Code：只写现行 `$KIMI_CODE_HOME/mcp.json`（默认 `~/.kimi-code/mcp.json`）。
 * 归档版 `~/.kimi/mcp.json` 只作检测证据，避免把配置写回旧路径。
 */
export const kimi: McpClientSpec = {
  id: "kimi",
  label: "Kimi Code",
  group: "cli",
  detect: [files(({ home }) => [inHome(home, ".kimi", "mcp.json")]), targets],
  async targets({ env, home }) {
    const dir = path.resolve(env.KIMI_CODE_HOME?.trim() || inHome(home, ".kimi-code"));
    return [target(path.join(dir, "mcp.json"), "json")];
  },
  entry: entry({ container: ["mcpServers"], fields: url => ({ url }) }),
  writer: { kind: "file" }
};
