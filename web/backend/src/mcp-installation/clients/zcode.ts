import type { McpClientSpec } from "./types.js";
import { app, entry, inHome, target, targets } from "./shared.js";

/**
 * ZCode：容器是两级键 `mcp.servers`，且 `.zcode` 命中后不再合并 `.agents/mcp.json`，
 * 因此只能写原生文件，不能写 `.agents`。
 */
export const zcode: McpClientSpec = {
  id: "zcode",
  label: "ZCode",
  group: "editor",
  detect: [app("ZCode"), targets],
  async targets({ home }) {
    return [target(inHome(home, ".zcode", "cli", "config.json"), "json")];
  },
  entry: entry({ container: ["mcp", "servers"], fields: url => ({ type: "http", url }), remoteType: "http" }),
  writer: { kind: "file" }
};
