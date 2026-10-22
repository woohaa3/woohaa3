import { useEffect, useState, type ReactNode } from "react";

/**
 * 可复用 dialog 视口（change: align-showcase-reference-ux，design D2 / 任务 1.1）。
 *
 * 目标：让 story 提供**完整可用视口**而不是固定 460px 内容框。舞台只负责把生产弹窗
 * 放进一个真实尺寸的盒子；弹窗的 Header/Footer 可达、Body 独立滚动等全部来自生产
 * `.dlg` 布局，这里不覆盖内部尺寸与 overflow。
 *
 * 两个稳定档位：
 * - 桌面：铺满可用内容宽度，高度取可用视口。
 * - 窄屏：固定 390×844（任务 1.1 要求的移动端视口）。
 */
export const DIALOG_VIEWPORT_NARROW_WIDTH = 390;
export const DIALOG_VIEWPORT_NARROW_HEIGHT = 844;

export type DialogViewportProps = {
	children: ReactNode;
	/** 使用 390×844 窄屏视口。 */
	narrow?: boolean;
	/** 覆盖舞台高度（默认桌面取可用视口，窄屏为 844）。 */
	height?: number;
	/** 覆盖舞台宽度（默认桌面 100%，窄屏 390）。 */
	width?: number;
	/** 供测试/定位用标识。 */
	testId?: string;
};

export function DialogViewport({
	children,
	narrow = false,
	height,
	width,
	testId,
}: DialogViewportProps) {
	const className = narrow
		? "showcase__dialog-box showcase__dialog-box--narrow"
		: "showcase__dialog-box";
	const style: Record<string, number> = {};
	if (width !== undefined) style.width = width;
	if (height !== undefined) style.height = height;
	return (
		<div className={className} data-testid={testId ?? "dialog-viewport"} style={style}>
			{children}
		</div>
	);
}

/** 单个 dialog 的预览舞台：caption + 视口（桌面或 390×844）。 */
export function DialogStage({
	children,
	caption,
	narrow = false,
	height,
	width,
	testId,
}: {
	children: ReactNode;
	caption: string;
	narrow?: boolean;
	height?: number;
	width?: number;
	testId?: string;
}) {
	return (
		<div className="showcase__stage">
			<div className="showcase__caption">{caption}</div>
			<DialogViewport narrow={narrow} height={height} width={width} testId={testId}>
				{children}
			</DialogViewport>
		</div>
	);
}

/**
 * 记录最近一次可观察事件（供 story 直接展示 contract 调用）。
 * fixture 只替换 IO，调用仍走生产组件回调（design D1）。
 */
export function useObservableLog<T>(): { entries: T[]; push: (entry: T) => void; reset: () => void } {
	const [entries, setEntries] = useState<T[]>([]);
	return {
		entries,
		push: (entry: T) => setEntries((current) => [...current, entry]),
		reset: () => setEntries([]),
	};
}

/** 观察日志的展示条（story 视觉验证用，不影响组件行为）。 */
export function ObservableLog({ label, entries }: { label: string; entries: unknown[] }) {
	return (
		<pre className="showcase__hint" data-testid="observable-log">
			{`${label} = ${JSON.stringify(entries, null, 2)}`}
		</pre>
	);
}

/**
 * 在挂载后读取一次布局盒：把「弹窗 Header/Footer 可达」这类事实暴露成可断言的
 * DOM 数据（交互测试与 Playwright 都消费同一份）。
 */
export function useDialogMetrics(selector: string) {
	const [metrics, setMetrics] = useState<{
		scrollHeight: number;
		clientHeight: number;
		scrollable: boolean;
	} | null>(null);
	useEffect(() => {
		const element = document.querySelector(selector);
		if (!(element instanceof HTMLElement)) return;
		setMetrics({
			scrollHeight: element.scrollHeight,
			clientHeight: element.clientHeight,
			scrollable: element.scrollHeight > element.clientHeight,
		});
	}, [selector]);
	return metrics;
}
