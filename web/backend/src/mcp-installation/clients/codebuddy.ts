import type { McpClientSpec } from "./types.js";
import { executable, entry, inHome, target, targets } from "./shared.js";

/**
 * CodeBuddy Code：官方有废弃迁移链
 * `~/.codebuddy/.mcp.json` → `~/.codebuddy/mcp.json` → `~/.codebuddy.json`。
 * 写第一个已存在的文件；都不存在时创建最高优先级那个，读回跟着同一目标。
 */
export const codebuddy: McpClientSpec = {
  id: "codebuddy",
  label: "CodeBuddy Code",
  group: "cli",
  detect: [executable("codebuddy"), targets],
  async targets({ home, exists }) {
    const chain = [
      inHome(home, ".codebuddy", ".mcp.json"),
      inHome(home, ".codebuddy", "mcp.json"),
      inHome(home, ".codebuddy.json")
    ];
    for (const file of chain) if (await exists(file)) return [target(file, "json")];
    return [target(chain[0]!, "json")];
  },
  entry: entry({ container: ["mcpServers"], fields: url => ({ type: "http", url }), remoteType: "http" }),
  writer: {
    kind: "command",
    names: ["codebuddy"],
    args: url => ["mcp", "add", "--scope", "user", "--transport", "http", "woohaa3-model-canvas", url]
  }
};
