import type { McpClientSpec } from "./types.js";
import { executable, entry, inHome, target, targets } from "./shared.js";

/** Factory Droid：官方 `droid mcp add --type http` 写 ~/.factory/mcp.json。 */
export const factoryDroid: McpClientSpec = {
  id: "factory-droid",
  label: "Factory Droid",
  group: "cli",
  detect: [executable("droid"), targets],
  async targets({ home }) {
    return [target(inHome(home, ".factory", "mcp.json"), "json")];
  },
  entry: entry({ container: ["mcpServers"], fields: url => ({ type: "http", url }), remoteType: "http" }),
  writer: {
    kind: "command",
    names: ["droid"],
    args: url => ["mcp", "add", "woohaa3-model-canvas", url, "--type", "http"]
  }
};
