/**
 * Design tokens for the Cordis UI layer (change: unify-application-theme-tokens).
 *
 * 颜色**不再是本地深色 palette**：全部指向根级语义 `--app-*` CSS variables（由唯一
 * Theme Provider 写入）。这样替换 preset 即可改色，无需改组件 selector 或 TS literal。
 * spacing/radius/shadow/font 等非色调 token 保持原样。
 */

/** 颜色访问器：只返回 `var(--app-*)`，保证组件不持有独立品牌色。 */
export const color = {
	panel: "var(--app-web-panel)",
	surface: "var(--app-web-surface)",
	surfaceHover: "var(--app-web-elevated)",
	chip: "var(--app-web-panel)",
	accent: "var(--app-interaction-accent)",
	accentWarm: "var(--app-status-danger)",
	text: "var(--app-web-text-primary)",
	textMuted: "var(--app-web-text-muted)",
	textFaint: "var(--app-web-text-muted)",
	border: "var(--app-web-border)",
	borderStrong: "var(--app-web-border-strong)",
	backdrop: "var(--app-web-backdrop)",
} as const;

export const radius = {
	/** ComposerBar / hud chips */
	panel: "22px",
	/** InspectorPanel */
	page: "26px",
	/** Inner cards, inputs */
	card: "14px",
	chip: "22px",
} as const;

export const shadow = {
	panel: "0 6px 22px var(--app-web-shadow)",
	card: "0 3px 10px var(--app-web-shadow)",
} as const;

export const space = {
	xs: "6px",
	sm: "10px",
	md: "16px",
	lg: "26px",
} as const;

export const font = {
	family:
		'"Noto Sans SC", "Noto Sans", system-ui, -apple-system, "Segoe UI", sans-serif',
	sizeSm: "13px",
	sizeBase: "16px",
	sizeLg: "18px",
	sizeTitle: "22px",
} as const;

export const theme = { color, radius, shadow, space, font } as const;

export type Theme = typeof theme;
