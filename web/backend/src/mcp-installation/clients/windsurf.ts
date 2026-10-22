import path from "node:path";
import type { McpClientSpec } from "./types.js";
import { app, configRoot, entry, files, target, targets } from "./shared.js";

/** Windsurf / Devin：Cascade 的 `mcp_config.json`，远程字段是 `serverUrl`。 */
export const windsurf: McpClientSpec = {
  id: "windsurf",
  label: "Windsurf / Devin",
  group: "editor",
  detect: [
    files(({ env, home, platform }) => [path.join(configRoot({ env, home, platform }), "devin", "mcp_config.json")]),
    app("Windsurf", "Devin"),
    targets
  ],
  async targets({ env, home, platform }) {
    return [target(path.join(configRoot({ env, home, platform }), "devin", "mcp_config.json"), "json")];
  },
  entry: entry({ container: ["mcpServers"], urlField: "serverUrl", fields: url => ({ serverUrl: url }) }),
  writer: { kind: "file" }
};
