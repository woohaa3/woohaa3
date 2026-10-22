import type { McpClientSpec } from "./types.js";
import { app, entry, files, inHome, target, targets } from "./shared.js";

/** WorkBuddy（腾讯）：`~/.workbuddy/mcp.json`，远程条目只有 `url`。 */
export const workbuddy: McpClientSpec = {
  id: "workbuddy",
  label: "WorkBuddy",
  group: "editor",
  detect: [
    files(({ home }) => [inHome(home, ".workbuddy", "mcp.json")]),
    app("WorkBuddy", "WorkBuddy AI"),
    targets
  ],
  async targets({ home }) {
    return [target(inHome(home, ".workbuddy", "mcp.json"), "json")];
  },
  entry: entry({ container: ["mcpServers"], fields: url => ({ url }) }),
  writer: { kind: "file" }
};
