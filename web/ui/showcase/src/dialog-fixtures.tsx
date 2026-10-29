import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import {
	DialogHost,
	DialogService,
	type DialogDefinition,
	type DialogRenderer,
} from "../../../frontend/src/cordis/ui/index.js";

/**
 * 生产 Dialog Host 的可组合 stage（change: align-showcase-reference-ux，design D1/D2）。
 *
 * story 直接使用生产的 `DialogHost` + `DialogService`，因此焦点进入/恢复、Escape、
 * Tab trap、关闭后不残留 overlay 全部走真实实现，而不是 story 自己模拟。
 * fixture 只在需要时替换 renderer 的 IO。
 */
export type ShowcaseDialogRegistration = {
	dialogId: string;
	definition: DialogDefinition;
	renderer: DialogRenderer;
};

/** 每次挂载创建独立 DialogService，避免 story 之间共享 stack。 */
export function useShowcaseDialogs(registrations: readonly ShowcaseDialogRegistration[]): DialogService {
	return useMemo(() => {
		const service = new DialogService();
		for (const registration of registrations) {
			service.registerDialog(registration.dialogId, registration);
		}
		return service;
		// registrations 由调用方模块级常量提供，稳定即可。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
}

export type DialogHostStageProps = {
	registrations: readonly ShowcaseDialogRegistration[];
	/** 打开按钮文案。 */
	triggerLabel: string;
	/** 要打开的 dialogId。 */
	dialogId: string;
	payload: unknown;
	/** 舞台标题。 */
	caption: string;
	/** 单次打开的额外说明。 */
	hint?: string;
};

/**
 * 触发按钮 + 生产 `DialogHost`。点击后弹窗由 Host 渲染并接管焦点；关闭后 Host
 * 卸载 overlay 并把焦点还给触发按钮（design D2）。
 */
export function DialogHostStage({
	registrations,
	triggerLabel,
	dialogId,
	payload,
	caption,
	hint,
}: DialogHostStageProps) {
	const service = useShowcaseDialogs(registrations);
	const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
	const [opened, setOpened] = useState(false);

	// stack 变空即代表弹窗已关闭；同步本地开关，故事可据此展示“已关闭”。
	useEffect(() => {
		if (opened && snapshot.stack.length === 0) setOpened(false);
	}, [opened, snapshot.stack.length]);

	return (
		<div className="showcase__stage">
			<div className="showcase__caption">{caption}</div>
			{hint ? <p className="showcase__hint">{hint}</p> : null}
			<button
				type="button"
				className="dlg__button dlg__button--primary"
				data-testid="dialog-trigger"
				onClick={() => {
					service.open({ dialogId, payload });
					setOpened(true);
				}}
			>
				{triggerLabel}
			</button>
			<span className="showcase__hint" data-testid="dialog-open-state">
				{opened ? "打开中" : "已关闭"}
			</span>
			{/* Host 只在 stack 非空时渲染 overlay；关闭后不残留任何拦截层。 */}
			<DialogHost dialogs={service} />
		</div>
	);
}

/**
 * 记录最近一次可观察事件（供 story 直接展示 contract 调用）。
 * fixture 只替换 IO，调用仍走生产组件回调（design D1）。
 */
export function useObservableLog<T>(): {
	entries: T[];
	push: (entry: T) => void;
	reset: () => void;
} {
	const [entries, setEntries] = useState<T[]>([]);
	return {
		entries,
		push: (entry: T) => setEntries((current) => [...current, entry]),
		reset: () => setEntries([]),
	};
}

/** 观察日志的展示条（story 视觉验证用，不影响组件行为）。 */
export function ObservableLog({ label, entries }: { label: string; entries: readonly unknown[] }) {
	return (
		<pre className="showcase__hint" data-testid="observable-log">
			{`${label} = ${JSON.stringify(entries, null, 2)}`}
		</pre>
	);
}

/** 供 story 在 caption 下展示任意补充说明。 */
export function StageNote({ children }: { children: ReactNode }) {
	return <p className="showcase__hint">{children}</p>;
}
