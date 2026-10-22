/**
 * WCAG 对比度工具与必需配对（change: unify-application-theme-tokens，任务 1.3 / design D8）。
 *
 * 纯函数，供 contrast 测试与 preset validator 复用。要求：
 * - 普通 primary text / surface 至少 4.5:1；
 * - 大文本、控件边界与 focus indicator 至少 3:1；
 * - on-accent、danger、selection、media controls 有显式可测配对。
 */
import { parseAppThemeHex } from "./parser.js";
import type { AppThemeSnapshot, AppThemeTokens } from "./schema.js";

export type Rgb = { r: number; g: number; b: number; a: number };

/** `#rrggbb` / `#rrggbbaa` → 分量；非法返回 null。 */
export function themeHexToRgb(value: string): Rgb | null {
  const normalized = parseAppThemeHex(value);
  if (normalized === null) return null;
  const hex = normalized.slice(1);
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
  };
}

/** 把（可能带 alpha 的）前景合成到不透明背景上。 */
export function compositeOver(fg: Rgb, bg: Rgb): Rgb {
  if (fg.a >= 1) return fg;
  return {
    r: Math.round(fg.r * fg.a + bg.r * (1 - fg.a)),
    g: Math.round(fg.g * fg.a + bg.g * (1 - fg.a)),
    b: Math.round(fg.b * fg.a + bg.b * (1 - fg.a)),
    a: 1
  };
}

function channelLuminance(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * channelLuminance(rgb.r) +
    0.7152 * channelLuminance(rgb.g) +
    0.0722 * channelLuminance(rgb.b)
  );
}

/** 主题的整体明暗外观；用于 `color-scheme` 与首帧回退，不参与业务判定。 */
export type AppThemeAppearance = "light" | "dark";

/**
 * 从语义 token 推导主题外观。
 *
 * 只看 `webBackdrop` 的相对亮度：它是应用最底层 surface，暗色 preset 的 backdrop 必须明显
 * 深于浅色 preset。颜色本身仍是唯一 authority，不额外维护 appearance 字段，避免同一事实
 * 在两处漂移。无法解析时回退 `light`（validator 已保证合法 hex，这里只是防御）。
 */
export function appThemeAppearance(theme: Pick<AppThemeSnapshot, "tokens">): AppThemeAppearance {
  const backdrop = themeHexToRgb(theme.tokens.webBackdrop);
  if (!backdrop) return "light";
  const opaque = compositeOver(backdrop, { r: 255, g: 255, b: 255, a: 1 });
  return relativeLuminance(opaque) < 0.18 ? "dark" : "light";
}

/**
 * WCAG 对比度（1..21）。前景先合成到背景上；背景本身若带 alpha 先合成到白色。
 */
export function contrastRatio(foreground: string, background: string): number {
  const fgRaw = themeHexToRgb(foreground);
  const bgRaw = themeHexToRgb(background);
  if (!fgRaw || !bgRaw) throw new Error("contrastRatio 需要规范 hex 颜色");
  const white: Rgb = { r: 255, g: 255, b: 255, a: 1 };
  const bg = compositeOver(bgRaw, white);
  const fg = compositeOver(fgRaw, bg);
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

/** 一组必须满足对比度阈值的语义配对。 */
export type ContrastPair = {
  id: string;
  foreground: keyof AppThemeTokens;
  background: keyof AppThemeTokens;
  /** 最小对比度（普通文本 4.5；大文本/非文本 3）。 */
  min: number;
  purpose: string;
};

/** D8 要求的必需配对（默认与任何合法 preset 都必须满足）。 */
export const APP_THEME_CONTRAST_PAIRS: readonly ContrastPair[] = [
  { id: "text-surface", foreground: "webTextPrimary", background: "webSurface", min: 4.5, purpose: "普通正文/面板文本" },
  { id: "text-panel", foreground: "webTextPrimary", background: "webPanel", min: 4.5, purpose: "面板正文" },
  { id: "text-backdrop", foreground: "webTextPrimary", background: "webBackdrop", min: 4.5, purpose: "页面背景正文" },
  { id: "muted-surface", foreground: "webTextMuted", background: "webSurface", min: 3, purpose: "大文本/次要文本" },
  { id: "accent-on-accent", foreground: "interactionOnAccent", background: "interactionAccent", min: 3, purpose: "accent 按钮文字" },
  { id: "accent-surface", foreground: "interactionAccent", background: "webSurface", min: 3, purpose: "accent 图标/边界" },
  { id: "focus-surface", foreground: "interactionFocus", background: "webSurface", min: 3, purpose: "focus indicator" },
  { id: "border-surface", foreground: "webBorderStrong", background: "webSurface", min: 3, purpose: "控件边界" },
  { id: "success-bg", foreground: "statusSuccess", background: "webSurface", min: 3, purpose: "success 非文本信号" },
  { id: "danger-on-danger", foreground: "statusOnDanger", background: "statusDanger", min: 3, purpose: "danger 按钮" },
  { id: "danger-surface", foreground: "statusDanger", background: "webSurface", min: 3, purpose: "danger 图标/文字" },
  { id: "warning-surface", foreground: "statusWarning", background: "webSurface", min: 3, purpose: "warning 非文本信号" },
  { id: "info-surface", foreground: "statusInfo", background: "webSurface", min: 3, purpose: "info 非文本信号" },
  { id: "canvas-selected", foreground: "canvasNodeBorderSelected", background: "canvasNodeSurface", min: 3, purpose: "selection 与节点 surface 的边界" },
  { id: "media-text", foreground: "mediaDialogText", background: "mediaDialogBackdrop", min: 4.5, purpose: "媒体弹窗文本" }
];

/** 计算所有必需配对的对比度；用于测试与诊断。 */
export function auditThemeContrast(theme: AppThemeSnapshot): Array<{ pair: ContrastPair; ratio: number; ok: boolean }> {
  return APP_THEME_CONTRAST_PAIRS.map((pair) => {
    const ratio = contrastRatio(theme.tokens[pair.foreground], theme.tokens[pair.background]);
    return { pair, ratio, ok: ratio + 1e-9 >= pair.min };
  });
}
