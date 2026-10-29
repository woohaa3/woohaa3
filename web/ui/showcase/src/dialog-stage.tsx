import type { ComponentType } from "react";

export type FakeDialogRenderer = ComponentType<{
	instance: {
		instanceId: string;
		dialogId: string;
		payload: unknown;
		parentInstanceId: null;
		dismissible: boolean;
		busy: boolean;
	};
	requestClose: () => void;
	setBusy: (busy: boolean) => void;
	replace: (payload: unknown) => void;
}>;

/**
 * 单个 dialog 的预览舞台：把某个 dialog 的 renderer 直接渲染在受控的假实例上。
 *
 * 真实运行时由 DialogHost 从 stack 解析 renderer；查看页为了聚焦单个弹窗外观，
 * 直接调用 renderer 并注入假的 `DialogRendererProps`。
 */
export function DialogStage({
	renderer,
	payload,
	instanceId,
	title,
	width,
	height,
	narrow,
}: {
	renderer: FakeDialogRenderer;
	payload: unknown;
	instanceId: string;
	title: string;
	width?: number;
	height?: number;
	narrow?: boolean;
}) {
	const Renderer = renderer;
	return (
		<div className="showcase__stage">
			<div className="showcase__caption">{title}</div>
			<div
				className={`showcase__dialog-box${narrow ? " showcase__dialog-box--narrow" : ""}`}
				style={{ ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) }}
			>
				<Renderer
					instance={{ instanceId, dialogId: instanceId, payload, parentInstanceId: null, dismissible: true, busy: false }}
					requestClose={() => undefined}
					setBusy={() => undefined}
					replace={() => undefined}
				/>
			</div>
		</div>
	);
}
