import path from "node:path";
import type { McpClientSpec } from "./types.js";
import { configRoot, executable, entry, target, targets } from "./shared.js";

/** OpenCode：JSONC 优先于 JSON；远程条目是 `mcp` 容器下的 `type: "remote"`。 */
export const opencode: McpClientSpec = {
  id: "opencode",
  label: "OpenCode",
  group: "cli",
  detect: [executable("opencode"), targets],
  async targets({ env, home, platform, exists }) {
    if (env.OPENCODE_CONFIG?.trim()) return [target(path.resolve(env.OPENCODE_CONFIG), "jsonc")];
    const dir = path.join(configRoot({ env, home, platform }), "opencode");
    // OpenCode loads JSONC after JSON; edit that effective file if both exist.
    const format = await exists(path.join(dir, "opencode.jsonc")) ? "jsonc" : "json";
    return [target(path.join(dir, `opencode.${format}`), format)];
  },
  entry: {
    ...entry({ container: ["mcp"], fields: url => ({ type: "remote", url, enabled: true }), remoteType: "remote" }),
    enabledField: "enabled"
  },
  writer: { kind: "file" }
};
