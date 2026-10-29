/**
 * 错误详情浮层
 * （change: 2026-09-28-split-frontend-god-plugins，task 6；从 ExecutionPanel.tsx 拆出；
 *  通过共享 Popover portal 避免被 dock 的裁切/滚动容器截断）。
 */
import { useState } from "react";
import { CloseIcon, Popover, WarningIcon } from "@woohaa3/ui";

export function ErrorInspector({ error }: { error: string }) {
	const [open, setOpen] = useState(false);
	return (
		<Popover
			open={open}
			onOpenChange={setOpen}
			side="top"
			align="end"
			sideOffset={8}
			className="mc-panel__error-panel"
			trigger={
				<button
					type="button"
					className="mc-panel__error-trigger"
					aria-label="查看错误详情"
				>
					<WarningIcon className="mc-panel__error-trigger-icon" />
				</button>
			}
		>
			<div className="mc-panel__error-panel-header">
				<strong>错误说明</strong>
				<button
					type="button"
					className="mc-panel__error-close"
					aria-label="关闭错误详情"
					onClick={() => setOpen(false)}
				>
					<CloseIcon className="mc-panel__error-close-icon" />
				</button>
			</div>
			<pre className="mc-panel__error-block">{error}</pre>
		</Popover>
	);
}
