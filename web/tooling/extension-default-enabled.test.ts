/**
 * 内置扩展默认启停门禁：外部用户第一次打开 app 拿到的开箱状态。
 *
 * 钉死两条事实：
 * 1. 声明了 `site` 的扩展**必须显式**写 `defaultEnabled`（布尔）。控制面把「未声明」当停用，
 *    漏写会静默变成关，事后看不出是故意还是忘了。
 * 2. `remote-server` 必须默认停用：公开用户没有可连的 woohaa-server，默认开着只会留下一个
 *    点不动的「服务端接入」入口。
 *
 * 只扫内置公开根 `web/extensions`；第二根 `extensions/` 由父仓注入，不在本仓门禁范围。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXTENSION_ROOT = path.join(REPO_ROOT, "web", "extensions");

type ExtensionDescriptor = { extensionId?: unknown; site?: { defaultEnabled?: unknown } };

/** 内置根里声明了 `site` 的扩展：`extensionId → site.defaultEnabled`（未申明时保留 undefined）。 */
function builtinSiteDefaults(): Map<string, unknown> {
  const defaults = new Map<string, unknown>();
  for (const entry of readdirSync(EXTENSION_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    let descriptor: ExtensionDescriptor;
    try {
      descriptor = JSON.parse(
        readFileSync(path.join(EXTENSION_ROOT, entry.name, "extension.json"), "utf8")
      ) as ExtensionDescriptor;
    } catch {
      // 没有 extension.json（框架包）或 JSON 不合法：那是 `extensions:check` 的职责。
      continue;
    }
    if (!descriptor.site) continue;
    defaults.set(String(descriptor.extensionId ?? entry.name), descriptor.site.defaultEnabled);
  }
  return defaults;
}

describe("内置扩展默认启停", () => {
  const defaults = builtinSiteDefaults();

  it("声明 site 的扩展必须显式写 defaultEnabled", () => {
    const missing = [...defaults]
      .filter(([, value]) => typeof value !== "boolean")
      .map(([extensionId]) => extensionId);
    expect(
      missing,
      "补上 site.defaultEnabled：控制面把未声明当停用，开箱状态必须是显式决定，不能靠缺省。"
    ).toEqual([]);
  });

  it("remote-server 默认停用；local-agent / sdk-agent 默认启用", () => {
    expect(
      defaults.get("remote-server"),
      "公开用户没有可连的 woohaa-server，默认开着只会留下点不动的入口。"
    ).toBe(false);
    expect(defaults.get("local-agent")).toBe(true);
    expect(defaults.get("sdk-agent")).toBe(true);
  });
});
