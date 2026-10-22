import path from "node:path";
import type { McpClientSpec } from "./types.js";
import { executable, entry, inHome, target, targets } from "./shared.js";

/** Qoder：官方 `qoder mcp add` 写 ~/.qoder/settings.json。 */
export const qoder: McpClientSpec = {
  id: "qoder",
  label: "Qoder",
  group: "cli",
  detect: [executable("qoder"), targets],
  async targets({ env, home }) {
    return [target(path.resolve(env.QODER_CONFIG_DIR?.trim() || inHome(home, ".qoder"), "settings.json"), "json")];
  },
  entry: entry({ container: ["mcpServers"], fields: url => ({ type: "http", url }), remoteType: "http" }),
  writer: {
    kind: "command",
    names: ["qoder"],
    args: url => ["mcp", "add", "woohaa3-model-canvas", url]
  }
};
