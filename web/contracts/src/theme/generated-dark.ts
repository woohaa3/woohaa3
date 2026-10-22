// 由 scripts/generate-theme-tokens.mjs 生成，请勿手工编辑。
// canonical source: web/contracts/src/theme/app-theme.dark.json
import type { AppThemeTokens } from "./schema.js";

/** 暗色 preset token（规范小写 hex）。 */
export const APP_THEME_DARK_TOKENS = {
  // web
  webBackdrop: "#101614",
  webSurface: "#151c19",
  webPanel: "#18201c",
  webElevated: "#1d2722",
  webSubtle: "#202a25",
  webTextPrimary: "#e6efe9",
  webTextMuted: "#93a69b",
  webTextInverse: "#f5faf7",
  webBorder: "#2b3731",
  webBorderStrong: "#6b8175",
  webOverlay: "#050908cc",
  webShadow: "#00000066",
  // interaction
  interactionAccent: "#2fb99b",
  interactionAccentHover: "#3fc9ab",
  interactionAccentPressed: "#27a88d",
  interactionAccentSoft: "#173b32",
  interactionFocus: "#2fb99b",
  interactionOnAccent: "#07120e",
  interactionDisabled: "#5d6e66",
  // status
  statusSuccess: "#35a686",
  statusSuccessSoft: "#1e4a3b",
  statusSuccessBackground: "#12332a",
  statusOnSuccess: "#06120e",
  statusWarning: "#d9a93f",
  statusWarningSoft: "#4a3a18",
  statusWarningBackground: "#33270f",
  statusOnWarning: "#1a1305",
  statusDanger: "#d76d7c",
  statusDangerSoft: "#4a2730",
  statusDangerBackground: "#33181f",
  statusOnDanger: "#1f0b10",
  statusInfo: "#6aa6d6",
  statusInfoSoft: "#1f3850",
  statusInfoBackground: "#142739",
  statusOnInfo: "#08141f",
  // canvas
  canvasNodeSurface: "#1b2420",
  canvasNodeContent: "#202b26",
  canvasNodeBorder: "#34443c",
  canvasNodeBorderSelected: "#2fb99b",
  canvasNodeShadow: "#00000055",
  canvasNodeSelectedHalo: "#1d4a3e",
  canvasEdgeDefault: "#546b60",
  canvasEdgeSelected: "#2fb99b",
  canvasEdgeDraft: "#2fb99b",
  canvasEdgeLabelBackground: "#101614",
  canvasEdgeLabelText: "#c5d5cc",
  canvasPortDefault: "#63796e",
  canvasPortFill: "#1b2420",
  canvasResizeHandle: "#c5d5cc",
  canvasResizeHandleStripe: "#101614",
  canvasProgressTrack: "#2b3731",
  canvasProgressFill: "#2fb99b",
  canvasCloseIcon: "#93a69b",
  canvasBodyText: "#c3d2c9",
  // nodeKind
  nodeTextForeground: "#7fb9e8",
  nodeTextTint: "#162b3b",
  nodeImageForeground: "#e08fb0",
  nodeImageTint: "#3a1f2b",
  nodeModelForeground: "#5ecbb8",
  nodeModelTint: "#12312c",
  nodeAudioForeground: "#e0b45e",
  nodeAudioTint: "#3a2d14",
  nodeVideoForeground: "#d99a6c",
  nodeVideoTint: "#3a2619",
  nodeDefaultForeground: "#a9bdb1",
  nodeDefaultTint: "#232f29",
  // grid
  gridMinor: "#1f2a25",
  gridMajor: "#2b3a32",
  gridSelection: "#2fb99b",
  gridGizmo: "#7fb9e8",
  // mediaDialog
  mediaDialogBackdrop: "#070b09f2",
  mediaDialogSurface: "#070b09f2",
  mediaDialogText: "#eef5f0",
  mediaDialogTextMuted: "#b5c7bc",
  mediaDialogControl: "#18201c",
  mediaDialogControlBorder: "#52685c",
} as const satisfies AppThemeTokens;

export const APP_THEME_DARK_ID = "dark";
export const APP_THEME_DARK_FINGERPRINT = "b291ab5ad0cdb3e3";

/** 暗色 preset（生成物）；结构与 `app-theme.dark.json` 一致。 */
export const APP_THEME_DARK_PRESET = {
  id: APP_THEME_DARK_ID,
  version: "woohaa-app-theme-v1" as const,
  tokens: APP_THEME_DARK_TOKENS
} as const;
