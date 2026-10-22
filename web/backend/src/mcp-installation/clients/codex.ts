import path from "node:path";
import type { McpClientSpec } from "./types.js";
import { executable, entry, inHome, target, targets } from "./shared.js";

/** Codex：官方 `codex mcp add` 写入 $CODEX_HOME/config.toml。 */
export const codex: McpClientSpec = {
  id: "codex",
  label: "Codex",
  group: "cli",
  detect: [executable("codex"), targets],
  async targets({ env, home }) {
    return [target(path.resolve(env.CODEX_HOME?.trim() || inHome(home, ".codex"), "config.toml"), "toml")];
  },
  entry: entry({ container: ["mcp_servers"], fields: url => ({ url }) }),
  writer: {
    kind: "command",
    names: ["codex"],
    args: url => ["mcp", "add", "woohaa3-model-canvas", "--url", url],
    env: (item, env) => ({ ...env, CODEX_HOME: path.dirname(item.path) })
  }
};
