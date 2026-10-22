/**
 * 内置应用主题 preset 注册表。
 *
 * 这些是产品随构建发布、可在设置「外观」中直接选择的 preset；它们与测试/showcase 的
 * sentinel fixture 不同，属于真实产品主题。每个 preset 仍必须通过 `validateAppThemePreset`
 * 的完整 schema/hex 校验，非法生成物在加载时即抛错，不会静默降级。
 */
import { APP_THEME_DARK_PRESET } from "./generated-dark.js";
import { APP_THEME_DEFAULT_PRESET } from "./generated-default.js";
import { validateAppThemePreset } from "./parser.js";
import type { AppThemeSnapshot } from "./schema.js";

/** 内置 preset 原始对象（由生成物提供；id 与 key 一致）。 */
export const APP_THEME_BUILTIN_PRESETS = {
  default: APP_THEME_DEFAULT_PRESET,
  dark: APP_THEME_DARK_PRESET
} as const;

export type AppThemeBuiltinPresetId = keyof typeof APP_THEME_BUILTIN_PRESETS;

/** 内置 preset id（稳定顺序，供 UI 渲染选择项）。 */
export const APP_THEME_BUILTIN_PRESET_IDS: readonly AppThemeBuiltinPresetId[] = Object.keys(
  APP_THEME_BUILTIN_PRESETS
) as AppThemeBuiltinPresetId[];

/** 解析一个内置 preset 为经验证的不可变 snapshot；生成物漂移时抛错。 */
export function builtinAppTheme(id: AppThemeBuiltinPresetId): AppThemeSnapshot {
  const result = validateAppThemePreset(APP_THEME_BUILTIN_PRESETS[id]);
  if (!result.ok) {
    throw new Error(`内置 ${id} 主题非法（生成物漂移）：${result.code} ${result.error}`);
  }
  return result.theme;
}

/** 内置暗色主题 snapshot（与 `defaultAppTheme()` 同构）。 */
export function darkAppTheme(): AppThemeSnapshot {
  return builtinAppTheme("dark");
}
