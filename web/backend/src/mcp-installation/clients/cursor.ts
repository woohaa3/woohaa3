import path from "node:path";
import type { McpClientSpec } from "./types.js";
import { app, entry, executable, files, inHome, target, targets } from "./shared.js";

/**
 * Cursor：桌面端与 `cursor-agent` 共享 `~/.cursor/mcp.json`，因此只有一条规格、
 * 一个安装目标，避免同一文件出现两个安装按钮。
 */
export const cursor: McpClientSpec = {
  id: "cursor",
  label: "Cursor",
  group: "editor",
  detect: [
    executable("cursor-agent"),
    files(({ home }) => [inHome(home, ".cursor", "mcp.json")]),
    app("Cursor"),
    targets
  ],
  async targets({ home }) {
    return [target(inHome(home, ".cursor", "mcp.json"), "json")];
  },
  entry: entry({ container: ["mcpServers"], fields: url => ({ url }) }),
  writer: { kind: "file" }
};
export const cursorPath = (home: string) => path.join(home, ".cursor", "mcp.json");
