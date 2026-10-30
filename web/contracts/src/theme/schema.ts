/**
 * 统一应用主题 token schema（change: unify-application-theme-tokens，任务 1.1 / 1.2 / design D1）。
 *
 * 这是**唯一**的版本化语义色 token 集合：Web app chrome 与 Bevy canvas chrome 都只按用途
 * 读取这些 token，不再各自维护平行 palette。所有跨运行时颜色使用规范 `#RRGGBB` 或
 * `#RRGGBBAA` sRGB 字面值。
 *
 * 本模块是**纯声明 + 无副作用类型**：只定义 token 名称/分组、schema 版本与限制常量。
 * 内置浅色/暗色值分别由 `generated-default.ts` / `generated-dark.ts`（从 canonical preset
 * 生成）提供，校验在 `parser.ts`，内置注册表在 `builtins.ts`。
 */

/** Theme schema 版本；新增/删除 token 必须提升它，并同步三端消费者。 */
export const APP_THEME_SCHEMA_VERSION = "woohaa-app-theme-v3" as const;
export type AppThemeSchemaVersion = typeof APP_THEME_SCHEMA_VERSION;

/** 允许的最大 preset JSON 字节数（防御任意大输入）。 */
export const APP_THEME_MAX_JSON_BYTES = 16 * 1024;
/** 允许的最大 preset id 长度。 */
export const APP_THEME_MAX_ID_LENGTH = 80;
/** 每个 token 值的最大长度（合法 hex 远小于此；用于拒绝超长注入串）。 */
export const APP_THEME_MAX_TOKEN_LENGTH = 16;

/**
 * 规范 hex 颜色：`#RRGGBB` 或 `#RRGGBBAA`（大小写不敏感）。拒绝 `url()`、`var()`、
 * gradient、CSS function、控制字符与任何其它形态。
 */
export const APP_THEME_HEX_PATTERN = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** token 分组，仅用于文档/生成物注释与可读性，不影响扁平存储。 */
export const APP_THEME_TOKEN_GROUPS = {
  web: [
    "webBackdrop",
    "webSurface",
    "webPanel",
    "webElevated",
    "webSubtle",
    "webTextPrimary",
    "webTextMuted",
    "webTextInverse",
    "webBorder",
    "webBorderStrong",
    "webOverlay",
    "webShadow"
  ],
  interaction: [
    "interactionAccent",
    "interactionAccentHover",
    "interactionAccentPressed",
    "interactionAccentSoft",
    "interactionFocus",
    "interactionOnAccent",
    "interactionDisabled"
  ],
  status: [
    "statusSuccess",
    "statusSuccessSoft",
    "statusSuccessBackground",
    "statusOnSuccess",
    "statusWarning",
    "statusWarningSoft",
    "statusWarningBackground",
    "statusOnWarning",
    "statusDanger",
    "statusDangerSoft",
    "statusDangerBackground",
    "statusOnDanger",
    "statusInfo",
    "statusInfoSoft",
    "statusInfoBackground",
    "statusOnInfo"
  ],
  canvas: [
    "canvasNodeSurface",
    "canvasNodeContent",
    "canvasNodeBorder",
    "canvasNodeBorderSelected",
    "canvasNodeShadow",
    "canvasNodeSelectedHalo",
    "canvasGroupSurface",
    "canvasGroupLabel",
    "canvasGroupLabelText",
    "canvasEdgeDefault",
    "canvasEdgeSelected",
    "canvasEdgeDraft",
    "canvasEdgeLabelBackground",
    "canvasEdgeLabelText",
    "canvasPortDefault",
    "canvasPortFill",
    "canvasResizeHandle",
    "canvasResizeHandleStripe",
    "canvasProgressTrack",
    "canvasProgressFill",
    "canvasCloseIcon",
    "canvasBodyText",
    "canvasStickySurface",
    "canvasStickyBorder",
    "canvasStickyText",
    "canvasStickyShadow"
  ],
  nodeKind: [
    "nodeTextForeground",
    "nodeTextTint",
    "nodeImageForeground",
    "nodeImageTint",
    "nodeModelForeground",
    "nodeModelTint",
    "nodeAudioForeground",
    "nodeAudioTint",
    "nodeVideoForeground",
    "nodeVideoTint",
    "nodeDefaultForeground",
    "nodeDefaultTint"
  ],
  gizmo: ["gizmoAxisX", "gizmoAxisY", "gizmoAxisZ"],
  grid: ["gridMinor", "gridMajor", "gridSelection", "gridGizmo"],
  mediaDialog: [
    "mediaDialogBackdrop",
    "mediaDialogSurface",
    "mediaDialogText",
    "mediaDialogTextMuted",
    "mediaDialogControl",
    "mediaDialogControlBorder"
  ]
} as const;

export type AppThemeTokenGroup = keyof typeof APP_THEME_TOKEN_GROUPS;

/** 扁平 token 名称联合类型（与 canonical preset 的 key 集合一一对应）。 */
export type AppThemeTokenName = {
  [G in AppThemeTokenGroup]: (typeof APP_THEME_TOKEN_GROUPS)[G][number];
}[AppThemeTokenGroup];

/** 所有 token 名称（稳定顺序：分组顺序 + 组内顺序）。 */
export const APP_THEME_TOKEN_NAMES: readonly AppThemeTokenName[] = Object.values(
  APP_THEME_TOKEN_GROUPS
).flat() as readonly AppThemeTokenName[];

const TOKEN_NAME_SET: ReadonlySet<string> = new Set(APP_THEME_TOKEN_NAMES);

/** 判定一个未知字符串是否是当前 schema 的已知 token 名。 */
export function isAppThemeTokenName(value: string): value is AppThemeTokenName {
  return TOKEN_NAME_SET.has(value);
}

/** 当前 schema 的必填 token 映射（名称 → 规范 hex 值）。 */
export type AppThemeTokens = Record<AppThemeTokenName, string>;

/** 不可变、带确定性 fingerprint 的主题快照。 */
export type AppThemeSnapshot = {
  /** 规范化后的 preset id。 */
  id: string;
  /** schema 版本常量。 */
  version: AppThemeSchemaVersion;
  /** 全部 token 的规范 hex 值（不可变）。 */
  tokens: Readonly<AppThemeTokens>;
  /** 基于 `id`/`version`/tokens 的确定性内容指纹（hex）。 */
  fingerprint: string;
};

/** preset 校验失败时的稳定错误码。 */
export type AppThemeErrorCode =
  | "not-object"
  | "prototype-bearing"
  | "unknown-key"
  | "missing-token"
  | "invalid-id"
  | "invalid-version"
  | "invalid-token"
  | "oversized";

export type AppThemeValidationResult =
  | { ok: true; theme: AppThemeSnapshot }
  | { ok: false; code: AppThemeErrorCode; error: string };
