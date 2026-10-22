import { readdir } from "node:fs/promises";
import path from "node:path";
import type { McpClientSpec, SpecContext } from "./types.js";
import { executable, files, inHome, target } from "./shared.js";

export const DSH_PLUGIN = "@deepseek-ai/dsh-mcp-client";

/** `$DSH_HOME` 默认 `~/.dsh`；每个 profile 目录是一份独立安装目标。 */
export function dshHome(ctx: Pick<SpecContext, "env" | "home">) {
  return path.resolve(ctx.env.DSH_HOME?.trim() || inHome(ctx.home, ".dsh"));
}

/**
 * 只列含 `cordis.patch.yml` 或 `package.json` 的目录，避免空目录/临时目录变成安装按钮。
 */
export async function discoverProfiles({ env, home, exists }: SpecContext) {
  const profiles = path.join(dshHome({ env, home }), "profiles");
  const entries = await readdir(profiles, { withFileTypes: true }).catch(() => []);
  const names = entries.filter(item => item.isDirectory()).map(item => item.name).sort();
  const found: string[] = [];
  for (const name of names) {
    const dir = path.join(profiles, name);
    if (await exists(path.join(dir, "cordis.patch.yml")) || await exists(path.join(dir, "package.json"))) found.push(name);
  }
  return found;
}

/** DeepSeek Harness：MCP 是 profile 内 `cordis.patch.yml` 的插件实例，不是独立 mcp.json。 */
export const deepseekHarness: McpClientSpec = {
  id: "deepseek-harness",
  label: "DeepSeek Harness",
  group: "cli",
  // 只有真正带上 patch / package.json 的 profile 目录才算已发现。
  detect: [
    executable("dsh"),
    files(async ctx => (await discoverProfiles(ctx)).map(name => path.join(dshHome(ctx), "profiles", name, "package.json"))),
    { kind: "targets" }
  ],
  async targets(ctx) {
    const profiles = await discoverProfiles(ctx);
    return profiles.map(name => ({
      ...target(path.join(dshHome(ctx), "profiles", name, "cordis.patch.yml"), "yaml", `${name} profile`),
      key: name,
      requiresPlugin: DSH_PLUGIN
    }));
  },
  entry: { container: ["insert"], array: true, urlField: "url", fields: url => ({ url }) },
  writer: { kind: "plugin-patch", plugin: DSH_PLUGIN }
};
