import path from "node:path";
import type { McpClientSpec } from "./types.js";
import { app, configRoot, entry, files, target, targets } from "./shared.js";

/** Zed：`context_servers` 容器，远程条目只有 `url`；不能动 `agent` 等顶层键。 */
export const zed: McpClientSpec = {
  id: "zed",
  label: "Zed",
  group: "editor",
  detect: [
    files(({ env, home, platform }) => [path.join(configRoot({ env, home, platform }), "zed", "settings.json")]),
    app("Zed"),
    targets
  ],
  async targets({ env, home, platform }) {
    return [target(path.join(configRoot({ env, home, platform }), "zed", "settings.json"), "jsonc")];
  },
  entry: entry({ container: ["context_servers"], fields: url => ({ url }) }),
  writer: { kind: "file" }
};
