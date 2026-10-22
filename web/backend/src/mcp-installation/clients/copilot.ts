import path from "node:path";
import type { McpClientSpec } from "./types.js";
import { app, entry, executable, files, inHome, target, targets } from "./shared.js";

/**
 * VS Code GitHub Copilot：写 `~/.copilot/mcp-config.json`（VS Code Copilot 与 Copilot CLI
 * 共用），不写 `.vscode/mcp.json`（项目级且使用不同的 `servers` 键）。
 */
export const copilot: McpClientSpec = {
  id: "copilot",
  label: "GitHub Copilot",
  group: "editor",
  detect: [
    executable("copilot"),
    files(({ env, home }) => [path.join(env.COPILOT_HOME?.trim() || inHome(home, ".copilot"), "mcp-config.json")]),
    app("Visual Studio Code"),
    targets
  ],
  async targets({ env, home }) {
    return [target(path.join(env.COPILOT_HOME?.trim() || inHome(home, ".copilot"), "mcp-config.json"), "json")];
  },
  entry: entry({ container: ["mcpServers"], fields: url => ({ type: "http", url }), remoteType: "http" }),
  writer: { kind: "file" }
};
