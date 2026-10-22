import path from "node:path";
import type { McpClientSpec } from "./types.js";
import { executable, entry, inHome, target, targets } from "./shared.js";

/** Claude Code：官方 `claude mcp add --transport http --scope user` 写入 $CLAUDE_CONFIG_DIR 或 ~/.claude.json。 */
export const claudeCode: McpClientSpec = {
  id: "claude-code",
  label: "Claude Code",
  group: "cli",
  detect: [executable("claude"), targets],
  async targets({ env, home }) {
    const dir = env.CLAUDE_CONFIG_DIR?.trim();
    return [target(dir ? path.join(path.resolve(dir), ".claude.json") : inHome(home, ".claude.json"), "json")];
  },
  entry: entry({ container: ["mcpServers"], fields: url => ({ type: "http", url }), remoteType: "http" }),
  writer: {
    kind: "command",
    names: ["claude"],
    args: url => ["mcp", "add", "--transport", "http", "--scope", "user", "woohaa3-model-canvas", url],
    env: item => ({ CLAUDE_CONFIG_DIR: path.dirname(item.path) })
  }
};
