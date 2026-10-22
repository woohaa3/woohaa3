import { describe, expect, it } from "vitest";
import { SETTING_DEFINITIONS, decodeSettingsWrite, describeSettings, diffSettings, legacyEnvInUse, providerIdFromConfigPrefix, resolveSettings } from "./index.js";
import { defineConfigSchema } from "../backend/host.js";

/**
 * 解析器测试用的定义表：url + secret + 旧环境变量语义。
 *
 * 不依赖宿主当前自带哪些配置项（`canvas.syncUpstream.*` 已随静态同步移除）。
 */
const UPSTREAM_DEFINITIONS = {
  ...SETTING_DEFINITIONS,
  "demo.upstream.url": {
    kind: "url",
    protocols: ["ws:", "wss:"],
    reload: "hot",
    legacyEnv: "WOOHAA3_CANVAS_SYNC_UPSTREAM_URL",
    label: "中继地址",
    description: "ws(s) 基址"
  },
  "demo.upstream.token": {
    kind: "string",
    secret: true,
    reload: "hot",
    legacyEnv: "WOOHAA3_CANVAS_SYNC_UPSTREAM_TOKEN",
    label: "令牌",
    description: "会话令牌"
  }
} as const;

describe("resolveSettings", () => {
  it("配置文件嵌套键展开，旧环境变量覆盖配置文件", () => {
    const fromFile = resolveSettings({ file: { demo: { upstream: { url: "ws://relay.local/" } } } }, { definitions: UPSTREAM_DEFINITIONS });
    expect(fromFile.issues).toEqual([]);
    expect(fromFile.values["demo.upstream.url"]).toBe("ws://relay.local");
    expect(fromFile.sources["demo.upstream.url"]).toBe("file");

    const overridden = resolveSettings({
      file: { demo: { upstream: { url: "ws://relay.local" } } },
      env: { WOOHAA3_CANVAS_SYNC_UPSTREAM_URL: "wss://relay.deploy" }
    }, { definitions: UPSTREAM_DEFINITIONS });
    expect(overridden.values["demo.upstream.url"]).toBe("wss://relay.deploy");
    expect(legacyEnvInUse(overridden, UPSTREAM_DEFINITIONS)).toEqual([{ key: "demo.upstream.url", env: "WOOHAA3_CANVAS_SYNC_UPSTREAM_URL" }]);
  });

  it("敏感项只能来自密钥文件，普通项不能写进密钥文件", () => {
    const misplaced = resolveSettings({
      file: { demo: { upstream: { token: "alice" } } },
      secrets: { demo: { upstream: { url: "ws://x" } } }
    }, { definitions: UPSTREAM_DEFINITIONS });
    expect(misplaced.issues.map((issue) => [issue.layer, issue.key])).toEqual([
      ["file", "demo.upstream.token"],
      ["secrets", "demo.upstream.url"]
    ]);
    const ok = resolveSettings({ secrets: { demo: { upstream: { token: "alice" } } } }, { definitions: UPSTREAM_DEFINITIONS });
    expect(ok.values["demo.upstream.token"]).toBe("alice");
    expect(ok.sources["demo.upstream.token"]).toBe("secrets");
  });

  it("未知键与非法值报告问题，空值视为未配置", () => {
    const resolved = resolveSettings({
      file: { demo: { upstream: { url: "http://relay" }, typo: 1 } },
      env: { WOOHAA3_CANVAS_SYNC_UPSTREAM_TOKEN: "" }
    }, { definitions: UPSTREAM_DEFINITIONS });
    expect(resolved.issues.map((issue) => issue.key).sort()).toEqual(["demo.typo", "demo.upstream.url"]);
    expect(resolved.values["demo.upstream.token"]).toBeUndefined();
    expect(resolveSettings({ file: { demo: { upstream: { url: null } } } }, { definitions: UPSTREAM_DEFINITIONS }).issues).toEqual([]);
  });

  it("设置面描述不回显敏感值，并标出环境变量锁定", () => {
    const resolved = resolveSettings({
      secrets: { demo: { upstream: { token: "alice" } } },
      env: { WOOHAA3_CANVAS_SYNC_UPSTREAM_URL: "ws://relay" }
    }, { definitions: UPSTREAM_DEFINITIONS });
    const byKey = Object.fromEntries(describeSettings(resolved, UPSTREAM_DEFINITIONS).map((entry) => [entry.key, entry]));
    expect(byKey["demo.upstream.token"]).toMatchObject({ value: null, configured: true, lockedBy: null });
    expect(byKey["demo.upstream.url"]).toMatchObject({ value: "ws://relay", lockedBy: "WOOHAA3_CANVAS_SYNC_UPSTREAM_URL" });
  });

  it("设置面描述带上界面需要的名称、类型与协议", () => {
    const byKey = Object.fromEntries(describeSettings(resolveSettings({}, { definitions: UPSTREAM_DEFINITIONS }), UPSTREAM_DEFINITIONS).map((entry) => [entry.key, entry]));
    expect(byKey["demo.upstream.url"]).toMatchObject({ kind: "url", label: "中继地址", protocols: ["ws:", "wss:"], configured: false });
    expect(byKey["demo.upstream.token"]).toMatchObject({ kind: "string", secret: true });
    expect(byKey["demo.upstream.token"]).not.toHaveProperty("protocols");
  });

  it("decodeSettingsWrite 只接受标量与 null", () => {
    expect(decodeSettingsWrite({ values: { a: "x", b: 1, c: true, d: null } })).toEqual({ ok: true, value: { values: { a: "x", b: 1, c: true, d: null } } });
    expect(decodeSettingsWrite({ values: { a: { nested: 1 } } }).ok).toBe(false);
    expect(decodeSettingsWrite({}).ok).toBe(false);
  });

  it("diffSettings 只列出生效值变化的项", () => {
    expect(diffSettings({ "demo.upstream.url": "ws://a" }, { "demo.upstream.url": "ws://b" })).toEqual(["demo.upstream.url"]);
    expect(diffSettings({}, {})).toEqual([]);
  });
});

describe("providerIdFromConfigPrefix", () => {
  it("只认 providers. 开头的配置段前缀", () => {
    expect(providerIdFromConfigPrefix("providers.ark")).toBe("ark");
    expect(providerIdFromConfigPrefix("providers.ark.extra")).toBe("ark");
    expect(providerIdFromConfigPrefix("storage.local")).toBeNull();
    expect(providerIdFromConfigPrefix("providers.")).toBeNull();
    expect(providerIdFromConfigPrefix(undefined)).toBeNull();
  });
});

describe("defineConfigSchema", () => {
  const schema = defineConfigSchema({
    apiKey: { kind: "string", secret: true, label: "API Key", description: "密钥", reload: "hot" },
    baseUrl: { kind: "url", protocols: ["https:"], label: "地址", description: "地址", reload: "hot" },
    timeoutMs: { kind: "integer", label: "超时", description: "毫秒", reload: "hot", default: 1000, min: 1 }
  });

  it("补默认值、按字段类型解析", () => {
    expect(schema["~standard"].validate({ apiKey: "k", baseUrl: "https://a.example/", timeoutMs: "20" })).toEqual({
      value: { apiKey: "k", baseUrl: "https://a.example", timeoutMs: 20 }
    });
    expect(schema["~standard"].validate(undefined)).toEqual({ value: { timeoutMs: 1000 } });
  });

  it("非法值给出带键名的问题", () => {
    const result = schema["~standard"].validate({ baseUrl: "http://a", timeoutMs: 0 });
    expect("issues" in result ? result.issues.map((issue) => issue.path?.[0]) : []).toEqual(["baseUrl", "timeoutMs"]);
  });
});

describe("动态定义表", () => {
  it("未知键可收集而不报错，传入定义表后按定义解析", () => {
    const layers = { file: { providers: { demo: { baseUrl: "https://demo.example" } } }, secrets: { providers: { demo: { apiKey: "k" } } } };
    expect(resolveSettings(layers, { unknownKeys: "collect" })).toMatchObject({
      issues: [],
      unknown: ["providers.demo.baseUrl", "providers.demo.apiKey"]
    });
    expect(resolveSettings(layers).issues).toHaveLength(2);
    const definitions = {
      ...SETTING_DEFINITIONS,
      "providers.demo.baseUrl": { kind: "url", protocols: ["https:"], label: "地址", description: "地址", reload: "hot", group: "演示" },
      "providers.demo.apiKey": { kind: "string", secret: true, label: "API Key", description: "密钥", reload: "hot", group: "演示" }
    } as const;
    const resolved = resolveSettings(layers, { definitions });
    expect(resolved.values["providers.demo.apiKey"]).toBe("k");
    const described = describeSettings(resolved, definitions).find((entry) => entry.key === "providers.demo.apiKey");
    expect(described).toMatchObject({ group: "演示", value: null, configured: true });
  });
});
