import type { McpClientSpec } from "./types.js";
import { app, entry, files, inHome, target, targets } from "./shared.js";

/** Continue：`config.yaml` 里 `mcpServers` 是数组，条目靠 `name` 定位。 */
export const continueClient: McpClientSpec = {
  id: "continue",
  label: "Continue",
  group: "editor",
  detect: [
    files(({ home }) => [inHome(home, ".continue", "config.yaml")]),
    app("Continue"),
    targets
  ],
  async targets({ home }) {
    return [target(inHome(home, ".continue", "config.yaml"), "yaml")];
  },
  entry: entry({
    container: ["mcpServers"],
    array: true,
    fields: url => ({ type: "streamable-http", url })
  }),
  writer: { kind: "file" }
};
