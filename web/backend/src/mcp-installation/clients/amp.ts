import path from "node:path";
import type { McpClientSpec } from "./types.js";
import { configRoot, executable, entry, target, targets } from "./shared.js";

/** Amp：`amp mcpServers` 是二级容器，不能覆盖同级其他设置。 */
export const amp: McpClientSpec = {
  id: "amp",
  label: "Amp",
  group: "cli",
  detect: [executable("amp"), targets],
  async targets({ env, home, platform }) {
    return [target(path.join(configRoot({ env, home, platform }), "amp", "settings.json"), "json")];
  },
  entry: entry({ container: ["amp", "mcpServers"], fields: url => ({ url }) }),
  writer: {
    kind: "command",
    names: ["amp"],
    args: url => ["mcp", "add", "woohaa3-model-canvas", url]
  }
};
