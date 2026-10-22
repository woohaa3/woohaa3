import type { McpClientSpec } from "./types.js";
import { executable, entry, inHome, target, targets } from "./shared.js";

/** Qwen Code：文件合并写 ~/.qwen/settings.json；远程条目用 `httpUrl`。 */
export const qwenCode: McpClientSpec = {
  id: "qwen-code",
  label: "Qwen Code",
  group: "cli",
  detect: [executable("qwen"), targets],
  async targets({ home }) {
    return [target(inHome(home, ".qwen", "settings.json"), "json")];
  },
  entry: entry({ container: ["mcpServers"], fields: url => ({ httpUrl: url }), urlField: "httpUrl" }),
  writer: { kind: "file" }
};
