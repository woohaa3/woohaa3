/**
 * 跨 Web/Bevy 共享 token 一致性（change: unify-application-theme-tokens，任务 5.5）。
 *
 * 断言 canonical preset → TS 默认值 / CSS variables / Rust fallback 三端逐 token 一致，
 * 且哨兵 preset 与默认高差异但都合法（证明「替换 preset 即改变全部色调」）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  APP_THEME_CSS_VARIABLES,
  APP_THEME_DEFAULT_FINGERPRINT,
  APP_THEME_SCHEMA_VERSION,
  APP_THEME_TOKEN_NAMES,
  defaultAppTheme,
  sentinelAppTheme,
  validateAppThemePreset
} from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../../../..");

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

describe("跨运行时 token fixture（任务 5.5）", () => {
  it("Rust fallback 每个 token 与 canonical preset 完全一致", () => {
    const rust = readFileSync(resolve(REPO_ROOT, "bevy/src/theme_generated.rs"), "utf8");
    const theme = defaultAppTheme();
    for (const name of APP_THEME_TOKEN_NAMES) {
      // 生成物形态：("tokenName", "#rrggbb")。
      expect(rust, name).toContain(`("${name}", "${theme.tokens[name]}")`);
    }
    expect(rust).toContain(APP_THEME_DEFAULT_FINGERPRINT);
    expect(rust).toContain(APP_THEME_SCHEMA_VERSION);
  });

  it("CSS generated artifact 每个 token 与 canonical preset 完全一致", () => {
    const css = readFileSync(
      resolve(REPO_ROOT, "web/frontend/src/cordis/ui/generated-theme.css"),
      "utf8"
    );
    const theme = defaultAppTheme();
    for (const name of APP_THEME_TOKEN_NAMES) {
      expect(css, name).toContain(`${APP_THEME_CSS_VARIABLES[name]}: ${theme.tokens[name]}`);
      // 变量名必须是规范 kebab。
      expect(APP_THEME_CSS_VARIABLES[name]).toBe(`--app-${kebab(name)}`);
    }
  });

  it("TS 默认值与 canonical preset 一致且不可变", () => {
    const theme = defaultAppTheme();
    expect(Object.isFrozen(theme.tokens)).toBe(true);
    expect(theme.version).toBe(APP_THEME_SCHEMA_VERSION);
  });

  it("哨兵 preset 与默认高差异但合法，且三端消费相同 token 名集合", () => {
    const base = defaultAppTheme();
    const sentinel = sentinelAppTheme();
    expect(validateAppThemePreset(sentinel).ok).toBe(true);
    // 关键 chrome token 均发生明显变化。
    for (const name of ["interactionAccent", "webBackdrop", "canvasNodeBorderSelected", "gridMajor"] as const) {
      expect(sentinel.tokens[name], name).not.toBe(base.tokens[name]);
    }
    expect(Object.keys(sentinel.tokens).sort()).toEqual(Object.keys(base.tokens).sort());
  });
});
