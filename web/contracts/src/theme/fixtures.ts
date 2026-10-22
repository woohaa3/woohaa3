/**
 * 测试/showcase 专用 theme fixtures（change: unify-application-theme-tokens，任务 5.2 / design D10）。
 *
 * **不是**产品主题：只用于验收「替换 preset 即改变全部色调」的能力。哨兵 preset 与默认
 * 色调差异极大（深紫/青），但必须通过同一 schema/contrast 校验。
 */
import { validateAppThemePreset } from "./parser.js";
import { APP_THEME_DEFAULT_TOKENS } from "./generated-default.js";
import { APP_THEME_SCHEMA_VERSION, type AppThemeTokens } from "./schema.js";

/** 哨兵主题的 token 覆盖（其余沿用默认）。仅测试/showcase 使用。 */
const SENTINEL_OVERRIDES: Partial<AppThemeTokens> = {
  webBackdrop: "#faf5ff",
  webSurface: "#ffffff",
  webPanel: "#ffffff",
  webElevated: "#fdf8ff",
  webSubtle: "#f3ecff",
  webTextPrimary: "#1b1030",
  webTextMuted: "#5b4b7a",
  webTextInverse: "#ffffff",
  webBorder: "#e4d8f5",
  webBorderStrong: "#8b74b8",
  webOverlay: "#1b103080",
  webShadow: "#3a1d6633",

  interactionAccent: "#6d28d9",
  interactionAccentHover: "#5b21b6",
  interactionAccentPressed: "#4c1d95",
  interactionAccentSoft: "#ede9fe",
  interactionFocus: "#6d28d9",
  interactionOnAccent: "#ffffff",
  interactionDisabled: "#c4b5d8",

  statusSuccess: "#0f7a4d",
  statusSuccessSoft: "#7fd0ad",
  statusSuccessBackground: "#e4f6ee",
  statusOnSuccess: "#ffffff",
  statusWarning: "#8a5a00",
  statusWarningSoft: "#e7c98a",
  statusWarningBackground: "#fdf3df",
  statusOnWarning: "#ffffff",
  statusDanger: "#c0264f",
  statusDangerSoft: "#e0a7b0",
  statusDangerBackground: "#fbe9ee",
  statusOnDanger: "#ffffff",
  statusInfo: "#1d4ed8",
  statusInfoSoft: "#a9c0f0",
  statusInfoBackground: "#e6edfd",
  statusOnInfo: "#ffffff",

  canvasNodeSurface: "#ffffff",
  canvasNodeContent: "#f3ecff",
  canvasNodeBorder: "#d9c9f2",
  canvasNodeBorderSelected: "#6d28d9",
  canvasNodeShadow: "#e7ddf7",
  canvasNodeSelectedHalo: "#ede9fe",
  canvasEdgeDefault: "#a897cc",
  canvasEdgeSelected: "#6d28d9",
  canvasEdgeDraft: "#6d28d9",
  canvasEdgeLabelBackground: "#faf5ff",
  canvasEdgeLabelText: "#4c3a73",
  canvasPortDefault: "#b7a8d8",
  canvasPortFill: "#ffffff",
  canvasResizeHandle: "#4c3a73",
  canvasResizeHandleStripe: "#ffffff",
  canvasProgressTrack: "#e7ddf7",
  canvasProgressFill: "#6d28d9",
  canvasCloseIcon: "#8b74b8",
  canvasBodyText: "#4c3a73",

  nodeTextForeground: "#1d4ed8",
  nodeTextTint: "#e6edfd",
  nodeImageForeground: "#b8308b",
  nodeImageTint: "#fdeaf7",
  nodeModelForeground: "#0f7a72",
  nodeModelTint: "#e2f6f4",
  nodeAudioForeground: "#8a5a00",
  nodeAudioTint: "#fdf3df",
  nodeVideoForeground: "#b0501f",
  nodeVideoTint: "#fdece3",
  nodeDefaultForeground: "#4c3a73",
  nodeDefaultTint: "#f3ecff",

  gridMinor: "#e7def7",
  gridMajor: "#d3c1ee",
  gridSelection: "#6d28d9",
  gridGizmo: "#1d4ed8",

  mediaDialogBackdrop: "#160b2ef0",
  mediaDialogSurface: "#160b2ef0",
  mediaDialogText: "#f5f0ff",
  mediaDialogTextMuted: "#cbb9ea",
  mediaDialogControl: "#ffffff",
  mediaDialogControlBorder: "#8b74b8"
};

/** 哨兵 preset（严格合法 + 高差异）。 */
export const SENTINEL_THEME_PRESET = {
  id: "sentinel",
  version: APP_THEME_SCHEMA_VERSION,
  tokens: { ...APP_THEME_DEFAULT_TOKENS, ...SENTINEL_OVERRIDES }
} as const;

/** 校验后的哨兵 snapshot（加载即校验，失败会抛错）。 */
export function sentinelAppTheme() {
  const result = validateAppThemePreset(SENTINEL_THEME_PRESET);
  if (!result.ok) {
    throw new Error(`内置哨兵主题非法：${result.code} ${result.error}`);
  }
  return result.theme;
}
