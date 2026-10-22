import { describe, expect, it } from "vitest";
import {
  APP_THEME_CSS_VARIABLES,
  APP_THEME_TOKEN_NAMES,
  defaultAppTheme,
  sentinelAppTheme,
  validateAppThemePreset,
  APP_THEME_SCHEMA_VERSION,
  appThemeAppearance,
  darkAppTheme,
  type AppThemeTokens
} from "@woohaa3/contracts";
import {
  AppThemeService,
  THEME_SELECTION_STORAGE_KEY,
  themeCssVariables,
  writeTokens
} from "./service.js";

/** 最小 fake DOM 根容器：style.setProperty + dataset。 */
function fakeRoot(): HTMLElement {
  const store = new Map<string, string>();
  return {
    style: {
      setProperty: (name: string, value: string) => store.set(name, value),
      getPropertyValue: (name: string) => store.get(name) ?? ""
    },
    dataset: {}
  } as unknown as HTMLElement;
}

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    has: (key: string) => map.has(key)
  };
}

describe("AppThemeService（任务 2.1 / 2.5）", () => {
  it("默认持有内置主题，applyTo 原子写入全部 --app-* variables", () => {
    const service = new AppThemeService({ storage: null });
    const root = fakeRoot();
    const detach = service.applyTo(root);
    for (const name of APP_THEME_TOKEN_NAMES) {
      expect(root.style.getPropertyValue(APP_THEME_CSS_VARIABLES[name])).toBe(
        defaultAppTheme().tokens[name]
      );
    }
    detach();
  });

  it("替换 preset 原子更新全部变量并通知订阅者一次", () => {
    const service = new AppThemeService({ storage: null });
    const root = fakeRoot();
    service.applyTo(root);
    let notifications = 0;
    service.subscribe(() => {
      notifications += 1;
    });
    const sentinel = sentinelAppTheme();
    expect(service.setPreset(sentinel)).toEqual({ ok: true });
    expect(notifications).toBe(1);
    expect(service.getSnapshot().id).toBe("sentinel");
    expect(root.style.getPropertyValue(APP_THEME_CSS_VARIABLES.interactionAccent)).toBe(
      sentinel.tokens.interactionAccent
    );
  });

  it("非法 preset 整体拒绝并保留上一合法主题，产生安全诊断", () => {
    const service = new AppThemeService({ storage: null });
    const root = fakeRoot();
    service.applyTo(root);
    const before = service.getSnapshot();
    const invalid = { id: "x", version: APP_THEME_SCHEMA_VERSION, tokens: { ...defaultAppTheme().tokens, interactionAccent: "url(evil)" } };
    const result = service.setPreset(invalid);
    expect(result.ok).toBe(false);
    expect(service.getSnapshot()).toBe(before);
    expect(service.diagnostic()).toContain("invalid-token");
    // DOM 未被修改。
    expect(root.style.getPropertyValue(APP_THEME_CSS_VARIABLES.interactionAccent)).toBe(
      before.tokens.interactionAccent
    );
    // 成功切换清空诊断。
    service.setPreset(sentinelAppTheme());
    expect(service.diagnostic()).toBeNull();
  });

  it("默认注册内置浅色与暗色 preset；切暗色同时更新变量、color-scheme 与 data-app-theme", () => {
    const service = new AppThemeService({ storage: null });
    expect(service.presetIds()).toEqual(["default", "dark"]);
    const root = fakeRoot();
    service.applyTo(root);
    expect(root.style.colorScheme).toBe("light");
    expect(root.dataset.appTheme).toBe("light");
    expect(service.select("dark")).toEqual({ ok: true });
    const dark = darkAppTheme();
    expect(root.style.getPropertyValue(APP_THEME_CSS_VARIABLES.webBackdrop)).toBe(dark.tokens.webBackdrop);
    expect(root.style.getPropertyValue(APP_THEME_CSS_VARIABLES.webTextPrimary)).toBe(dark.tokens.webTextPrimary);
    expect(appThemeAppearance(dark)).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
    expect(root.dataset.appTheme).toBe("dark");
    // 切回浅色：内联变量与 color-scheme 都必须回到 light，不能残留 dark 属性。
    expect(service.select("default")).toEqual({ ok: true });
    expect(root.style.colorScheme).toBe("light");
    expect(root.dataset.appTheme).toBe("light");
  });

  it("未知 preset id 选择失败且保留上一主题", () => {
    const service = new AppThemeService({ storage: null, presets: {} });
    const result = service.select("nope");
    expect(result.ok).toBe(false);
    expect(service.getSnapshot().id).toBe("default");
  });

  it("从本地存储恢复合法选择；非法值被清除并保留默认", () => {
    const storage = memoryStorage({ [THEME_SELECTION_STORAGE_KEY]: "sentinel" });
    const service = new AppThemeService({
      storage,
      presets: { sentinel: sentinelAppTheme() }
    });
    expect(service.getSnapshot().id).toBe("sentinel");
    expect(storage.getItem(THEME_SELECTION_STORAGE_KEY)).toBe("sentinel");

    const badStorage = memoryStorage({ [THEME_SELECTION_STORAGE_KEY]: "missing" });
    const bad = new AppThemeService({ storage: badStorage });
    expect(bad.getSnapshot().id).toBe("default");
    expect(badStorage.has(THEME_SELECTION_STORAGE_KEY)).toBe(false);
  });

  it("从本地存储恢复内置暗色选择", () => {
    const storage = memoryStorage({ [THEME_SELECTION_STORAGE_KEY]: "dark" });
    const service = new AppThemeService({ storage });
    expect(service.getSnapshot().id).toBe("dark");
    const root = fakeRoot();
    service.applyTo(root);
    expect(root.dataset.appTheme).toBe("dark");
    expect(root.style.getPropertyValue(APP_THEME_CSS_VARIABLES.webBackdrop)).toBe(
      darkAppTheme().tokens.webBackdrop
    );
  });

  it("dispose 撤销订阅与根容器，迟到的 setPreset 被拒绝", () => {
    const service = new AppThemeService({ storage: null });
    const root = fakeRoot();
    service.applyTo(root);
    let notified = 0;
    service.subscribe(() => {
      notified += 1;
    });
    service.dispose();
    expect(service.setPreset(sentinelAppTheme()).ok).toBe(false);
    expect(notified).toBe(0);
  });

  it("writeTokens / themeCssVariables 覆盖全部 token", () => {
    const theme = defaultAppTheme();
    const map = themeCssVariables(theme);
    expect(Object.keys(map)).toHaveLength(APP_THEME_TOKEN_NAMES.length);
    const root = fakeRoot();
    writeTokens(root, theme);
    expect(root.style.getPropertyValue(APP_THEME_CSS_VARIABLES.webBackdrop)).toBe(theme.tokens.webBackdrop);
  });

  it("注册新的具名 preset 后可被 select 使用", () => {
    const service = new AppThemeService({ storage: null });
    const custom = { id: "custom", version: APP_THEME_SCHEMA_VERSION, tokens: defaultAppTheme().tokens as AppThemeTokens };
    service.registerPreset("custom", custom);
    expect(service.select("custom")).toEqual({ ok: true });
    expect(service.getSnapshot().id).toBe("custom");
  });

  it("theme preset 通过 contracts 校验（round-trip）", () => {
    const theme = sentinelAppTheme();
    expect(validateAppThemePreset(theme).ok).toBe(true);
    const service = new AppThemeService({ initial: theme, storage: null });
    expect(service.getSnapshot().fingerprint).toBe(theme.fingerprint);
  });
});
