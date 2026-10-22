/**
 * 提示词格式工具栏
 * （change: 2026-09-28-split-frontend-god-plugins，task 6；从 ExecutionPanel.tsx 拆出）。
 */
import type { ExecutionPanelFormatCommand } from "./types.js";

/** 富文本格式工具栏（对齐源工程 PromptFormattingToolbar）。 */
export function FormatToolbar({
	onCommand,
}: {
	onCommand?: (command: ExecutionPanelFormatCommand) => void;
}) {
	const keepSelection = (event: React.MouseEvent) => event.preventDefault();
	return (
		<div
			className="mc-panel__format-toolbar"
			role="toolbar"
			aria-label="提示词格式"
		>
			<button
				type="button"
				className="is-prominent"
				aria-label="正文"
				onMouseDown={keepSelection}
				onClick={() => onCommand?.({ type: "block", value: "paragraph" })}
			>
				¶
			</button>
			<span className="mc-panel__format-divider" />
			<button
				type="button"
				className="mc-panel__format-bold"
				aria-label="加粗"
				onMouseDown={keepSelection}
				onClick={() => onCommand?.({ type: "text", value: "bold" })}
			>
				B
			</button>
			<button
				type="button"
				className="mc-panel__format-italic"
				aria-label="斜体"
				onMouseDown={keepSelection}
				onClick={() => onCommand?.({ type: "text", value: "italic" })}
			>
				I
			</button>
			<button
				type="button"
				className="mc-panel__format-underline"
				aria-label="下划线"
				onMouseDown={keepSelection}
				onClick={() => onCommand?.({ type: "text", value: "underline" })}
			>
				U
			</button>
			<label className="mc-panel__format-color" aria-label="文字颜色">
				<span>A</span>
				<i />
				<input
					type="color"
					defaultValue="#f5f5f5"
					onChange={(event) =>
						onCommand?.({
							type: "style",
							property: "color",
							value: event.target.value,
						})
					}
				/>
			</label>
			<label className="mc-panel__format-highlight" aria-label="背景高亮">
				<span>◆</span>
				<i />
				<input
					type="color"
					defaultValue="#ff3b30"
					onChange={(event) =>
						onCommand?.({
							type: "style",
							property: "background-color",
							value: event.target.value,
						})
					}
				/>
			</label>
			<span className="mc-panel__format-divider" />
			<button
				type="button"
				className="mc-panel__format-clear"
				aria-label="清除格式"
				onMouseDown={keepSelection}
				onClick={() => onCommand?.({ type: "clear" })}
			>
				—
			</button>
		</div>
	);
}
