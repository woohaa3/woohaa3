import { type CSSProperties, type ReactNode } from "react";
import { color, font, radius, shadow, space } from "./theme.js";

export interface TipsProps {
	/** Heading line, e.g. "画布操作". */
	title?: string;
	/** Bullet lines shown under the heading. */
	items?: string[];
	/** Extra content rendered after the bullets. */
	children?: ReactNode;
	/** Override the default bottom-left anchor. */
	style?: CSSProperties;
}

const DEFAULT_ITEMS = [
	"拖到空白处 → 插入节点",
	"从节点右侧 + 拖出 → 连接下一环",
	"保存 JS 后自动刷新模型",
	"F5 / ⌘R 热更新 · 空格拍摄",
];

/**
 * Bottom-left hint card, styled to match the in-game HUD panels
 * (ComposerBar / ChatPanel).
 */
export function Tips({
	title = "画布操作",
	items = DEFAULT_ITEMS,
	children,
	style,
}: TipsProps) {
	return (
		<div
			data-canvas-ui="tips"
			style={{
				position: "fixed",
				left: space.lg,
				bottom: space.lg,
				zIndex: 20,
				minWidth: 208,
				maxWidth: 320,
				boxSizing: "border-box",
				padding: "14px 18px 16px",
				background: color.chip,
				border: `1px solid ${color.border}`,
				borderRadius: radius.panel,
				boxShadow: shadow.panel,
				color: color.text,
				fontFamily: font.family,
				fontSize: font.sizeSm,
				lineHeight: 1.55,
				backdropFilter: "blur(8px)",
				pointerEvents: "none",
				userSelect: "none",
				...style,
			}}
		>
			<div
				style={{
					fontSize: font.sizeBase,
					fontWeight: 600,
					letterSpacing: "0.01em",
					marginBottom: space.sm,
					color: color.text,
				}}
			>
				{title}
			</div>
			<ul
				style={{
					margin: 0,
					padding: 0,
					listStyle: "none",
					display: "flex",
					flexDirection: "column",
					gap: space.xs,
				}}
			>
				{items.map((item) => (
					<li
						key={item}
						style={{
							display: "flex",
							gap: space.sm,
							alignItems: "baseline",
							color: color.textMuted,
						}}
					>
						<span
							aria-hidden
							style={{
								flex: "0 0 auto",
								marginTop: 7,
								width: 5,
								height: 5,
								borderRadius: "50%",
								background: color.accent,
								opacity: 0.85,
							}}
						/>
						<span>{item}</span>
					</li>
				))}
			</ul>
			{children}
		</div>
	);
}
