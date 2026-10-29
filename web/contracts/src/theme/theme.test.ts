import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  APP_THEME_BUILTIN_PRESETS,
  APP_THEME_BUILTIN_PRESET_IDS,
  APP_THEME_DARK_FINGERPRINT,
  APP_THEME_DARK_PRESET,
  APP_THEME_DEFAULT_FINGERPRINT,
  APP_THEME_DEFAULT_PRESET,
  APP_THEME_HEX_PATTERN,
  APP_THEME_MAX_JSON_BYTES,
  APP_THEME_SCHEMA_VERSION,
  APP_THEME_TOKEN_NAMES,
  APP_THEME_TOKEN_GROUPS,
  appThemeAppearance,
  appThemeFingerprint,
  auditThemeContrast,
  builtinAppTheme,
  contrastRatio,
  darkAppTheme,
  defaultAppTheme,
  parseAppThemeHex,
  sentinelAppTheme,
  SENTINEL_THEME_PRESET,
  validateAppThemePreset,
  withAppThemeTokens,
  type AppThemeTokens
} from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));

function validPresetWith(override: Partial<Record<keyof AppThemeTokens, string>>): unknown {
  return { id: "t", version: APP_THEME_SCHEMA_VERSION, tokens: { ...defaultAppTheme().tokens, ...override } };
}

describe("AppTheme schema（任务 1.2）", () => {
  it("默认 preset 是完整、合法、不可变的 snapshot", () => {
    const theme = defaultAppTheme();
    expect(theme.version).toBe(APP_THEME_SCHEMA_VERSION);
    expect(theme.id).toBe("default");
    expect(Object.keys(theme.tokens).sort()).toEqual([...APP_THEME_TOKEN_NAMES].sort());
    expect(Object.isFrozen(theme)).toBe(true);
    expect(Object.isFrozen(theme.tokens)).toBe(true);
    expect(theme.fingerprint).toBe(APP_THEME_DEFAULT_FINGERPRINT);
  });

  it("fingerprint 是确定性的，且随 token 变化", () => {
    const base = defaultAppTheme();
    const again = validateAppThemePreset(APP_THEME_DEFAULT_PRESET);
    expect(again.ok && again.theme.fingerprint).toBe(base.fingerprint);
    const changed = withAppThemeTokens(base, "t", { interactionAccent: "#010203" });
    expect(changed.ok && changed.theme.fingerprint).not.toBe(base.fingerprint);
    expect(appThemeFingerprint({ id: base.id, version: base.version, tokens: base.tokens })).toBe(base.fingerprint);
  });

  it("拒绝缺少 token 的 preset（不得部分合并默认值）", () => {
    const tokens = { ...defaultAppTheme().tokens } as Record<string, string>;
    delete tokens.interactionAccent;
    const result = validateAppThemePreset({ id: "t", version: APP_THEME_SCHEMA_VERSION, tokens });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe("missing-token");
  });

  it("拒绝未知版本、未知 token 与非法 id", () => {
    expect(validateAppThemePreset({ id: "t", version: "v0", tokens: defaultAppTheme().tokens })).toMatchObject({ ok: false, code: "invalid-version" });
    expect(validateAppThemePreset({ id: "t", version: APP_THEME_SCHEMA_VERSION, tokens: { ...defaultAppTheme().tokens, extra: "#ffffff" } })).toMatchObject({ ok: false, code: "unknown-key" });
    expect(validateAppThemePreset({ id: "", version: APP_THEME_SCHEMA_VERSION, tokens: defaultAppTheme().tokens })).toMatchObject({ ok: false, code: "invalid-id" });
    expect(validateAppThemePreset({ id: "bad id", version: APP_THEME_SCHEMA_VERSION, tokens: defaultAppTheme().tokens })).toMatchObject({ ok: false, code: "invalid-id" });
  });

  it("拒绝 url()/var()/gradient/控制字符/超长/未知结构注入", () => {
    for (const evil of [
      "url(https://evil)",
      "var(--x)",
      "linear-gradient(red, blue)",
      "#fff",
      "#gggggg",
      "rgb(0,0,0)",
      "#ffffff\n",
      "red",
      `#${"a".repeat(200)}`
    ]) {
      const result = validateAppThemePreset(validPresetWith({ interactionAccent: evil }));
      expect(result.ok, `应拒绝 ${JSON.stringify(evil)}`).toBe(false);
      expect(result.ok === false && result.code).toBe("invalid-token");
    }
  });

  it("拒绝 prototype-bearing 输入", () => {
    const protoBearing = Object.create({ inherited: true }) as Record<string, unknown>;
    Object.assign(protoBearing, { id: "t", version: APP_THEME_SCHEMA_VERSION, tokens: defaultAppTheme().tokens });
    expect(validateAppThemePreset(protoBearing)).toMatchObject({ ok: false, code: "not-object" });
    // 顶层对象是普通对象，但 tokens 里出现 __proto__ 键：JSON.parse 会产生自有属性。
    const tokensWithProto = JSON.parse(
      `{"interactionAccent":"#16846c","__proto__":"#ffffff"}`
    ) as Record<string, string>;
    const result = validateAppThemePreset({ id: "t", version: APP_THEME_SCHEMA_VERSION, tokens: { ...defaultAppTheme().tokens, ...tokensWithProto } });
    expect(result.ok).toBe(false);
  });

  it("拒绝超限 JSON payload", () => {
    const huge = "x".repeat(APP_THEME_MAX_JSON_BYTES + 1);
    expect(validateAppThemePreset(huge)).toMatchObject({ ok: false, code: "oversized" });
  });
});

describe("hex parser（任务 1.2）", () => {
  it("只接受规范 #RRGGBB / #RRGGBBAA 并规范化为小写", () => {
    expect(parseAppThemeHex("#AABBCC")).toBe("#aabbcc");
    expect(parseAppThemeHex("#aabbccdd")).toBe("#aabbccdd");
    expect(parseAppThemeHex("#12345")).toBeNull();
    expect(parseAppThemeHex("aabbcc")).toBeNull();
    expect(parseAppThemeHex("#aabbccdddd")).toBeNull();
    expect(APP_THEME_HEX_PATTERN.test("#aabbcc")).toBe(true);
  });
});

describe("contrast（任务 1.3 / design D8）", () => {
  it("默认 preset 通过所有必需配对", () => {
    for (const entry of auditThemeContrast(defaultAppTheme())) {
      expect(entry.ratio, `${entry.pair.id}=${entry.ratio.toFixed(2)}`).toBeGreaterThanOrEqual(entry.pair.min - 1e-9);
      expect(entry.ok).toBe(true);
    }
  });

  it("哨兵 preset 也通过所有必需配对（高差异但合法）", () => {
    for (const entry of auditThemeContrast(sentinelAppTheme())) {
      expect(entry.ratio, `${entry.pair.id}=${entry.ratio.toFixed(2)}`).toBeGreaterThanOrEqual(entry.pair.min - 1e-9);
    }
  });

  it("对比度计算符合 WCAG 已知值（黑白 = 21）", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  it("对比不足的 preset 会被 audit 标为不通过", () => {
    const bad = withAppThemeTokens(defaultAppTheme(), "bad", { webTextPrimary: "#e5e5e5", webSurface: "#ffffff" });
    expect(bad.ok).toBe(true);
    if (bad.ok) {
      const entry = auditThemeContrast(bad.theme).find((item) => item.pair.id === "text-surface");
      expect(entry?.ok).toBe(false);
    }
  });
});

describe("内置 dark preset", () => {
  it("暗色 preset 完整、合法、与默认 fingerprint 不同", () => {
    const dark = darkAppTheme();
    expect(dark.id).toBe("dark");
    expect(dark.version).toBe(APP_THEME_SCHEMA_VERSION);
    expect(Object.keys(dark.tokens).sort()).toEqual([...APP_THEME_TOKEN_NAMES].sort());
    expect(dark.fingerprint).toBe(APP_THEME_DARK_FINGERPRINT);
    expect(dark.fingerprint).not.toBe(defaultAppTheme().fingerprint);
    expect(validateAppThemePreset(APP_THEME_DARK_PRESET).ok).toBe(true);
    expect(builtinAppTheme("dark").fingerprint).toBe(dark.fingerprint);
  });

  it("内置 preset 注册表与生成物 id 一致", () => {
    expect(APP_THEME_BUILTIN_PRESET_IDS).toEqual(["default", "dark"]);
    expect(Object.keys(APP_THEME_BUILTIN_PRESETS)).toEqual(["default", "dark"]);
  });

  it("暗色 preset 通过全部必需对比度配对", () => {
    for (const entry of auditThemeContrast(darkAppTheme())) {
      expect(entry.ratio, `${entry.pair.id}=${entry.ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
        entry.pair.min - 1e-9
      );
      expect(entry.ok).toBe(true);
    }
  });

  it("外观只由 backdrop 亮度推导", () => {
    expect(appThemeAppearance(defaultAppTheme())).toBe("light");
    expect(appThemeAppearance(sentinelAppTheme())).toBe("light");
    expect(appThemeAppearance(darkAppTheme())).toBe("dark");
  });
});

describe("sentinel preset（任务 5.2）", () => {
  it("与默认色调明显不同且合法", () => {
    const sentinel = sentinelAppTheme();
    const base = defaultAppTheme();
    expect(sentinel.id).toBe("sentinel");
    expect(sentinel.fingerprint).not.toBe(base.fingerprint);
    expect(sentinel.tokens.interactionAccent).not.toBe(base.tokens.interactionAccent);
    expect(validateAppThemePreset(SENTINEL_THEME_PRESET).ok).toBe(true);
  });

  it("token 分组覆盖 schema 全部 token", () => {
    const grouped = Object.values(APP_THEME_TOKEN_GROUPS).flat();
    expect([...grouped].sort()).toEqual([...APP_THEME_TOKEN_NAMES].sort());
  });
});

describe("canonical 生成物一致性（任务 1.4）", () => {
  it("app-theme.default.json 与生成默认值逐 token 一致", () => {
    const canonical = JSON.parse(
      readFileSync(resolve(here, "app-theme.default.json"), "utf8")
    ) as { id: string; version: string; tokens: Record<string, string> };
    expect(canonical.version).toBe(APP_THEME_SCHEMA_VERSION);
    expect(canonical.id).toBe(APP_THEME_DEFAULT_PRESET.id);
    const theme = defaultAppTheme();
    for (const name of APP_THEME_TOKEN_NAMES) {
      expect(theme.tokens[name], name).toBe(canonical.tokens[name].toLowerCase());
    }
  });

  it("app-theme.dark.json 与生成暗色值逐 token 一致", () => {
    const canonical = JSON.parse(
      readFileSync(resolve(here, "app-theme.dark.json"), "utf8")
    ) as { id: string; version: string; tokens: Record<string, string> };
    expect(canonical.version).toBe(APP_THEME_SCHEMA_VERSION);
    expect(canonical.id).toBe(APP_THEME_DARK_PRESET.id);
    const theme = darkAppTheme();
    for (const name of APP_THEME_TOKEN_NAMES) {
      expect(theme.tokens[name], name).toBe(canonical.tokens[name].toLowerCase());
    }
  });

  it("CSS 生成物为每个 token 暴露 --app-* variable，并含暗色首帧块", () => {
    const css = readFileSync(resolve(here, "../../../ui/src/styles/generated-theme.css"), "utf8");
    for (const name of APP_THEME_TOKEN_NAMES) {
      const kebab = name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
      expect(css, name).toContain(`--app-${kebab}:`);
    }
    expect(css).toContain(':root[data-app-theme="dark"]');
    expect(css).toContain("color-scheme: dark;");
    expect(css).toContain(`--app-web-backdrop: ${darkAppTheme().tokens.webBackdrop};`);
  });

  it("Rust 生成物包含全部 token 与 fingerprint", () => {
    const rust = readFileSync(resolve(here, "../../../../bevy/src/theme_generated.rs"), "utf8");
    expect(rust).toContain(APP_THEME_DEFAULT_FINGERPRINT);
    for (const name of APP_THEME_TOKEN_NAMES) {
      expect(rust, name).toContain(`("${name}",`);
    }
  });
});

it.each(["gizmoAxisX", "gizmoAxisY", "gizmoAxisZ"])("rejects a theme missing %s atomically", key => {
  const tokens={...defaultAppTheme().tokens} as Record<string,string>;
  delete tokens[key];
  expect(validateAppThemePreset({id:"incomplete",version:APP_THEME_SCHEMA_VERSION,tokens})).toMatchObject({ok:false,code:"missing-token"});
});
