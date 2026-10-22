import type { McpClientSpec } from "./types.js";
import { executable, entry, inHome, target, targets } from "./shared.js";

/** Gemini CLI：官方命令写入 ~/.gemini/settings.json；远程条目用专有字段 `httpUrl`。 */
export const geminiCli: McpClientSpec = {
  id: "gemini-cli",
  label: "Gemini CLI",
  group: "cli",
  detect: [executable("gemini"), targets],
  async targets({ home }) {
    return [target(inHome(home, ".gemini", "settings.json"), "json")];
  },
  entry: entry({ container: ["mcpServers"], fields: url => ({ httpUrl: url }), urlField: "httpUrl" }),
  writer: {
    kind: "command",
    names: ["gemini"],
    args: url => ["mcp", "add", "--transport", "http", "--scope", "user", "woohaa3-model-canvas", url]
  }
};
