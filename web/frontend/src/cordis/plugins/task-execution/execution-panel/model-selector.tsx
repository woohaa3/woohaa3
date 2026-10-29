/**
 * 模型选择与参数菜单
 * （change: 2026-09-28-split-frontend-god-plugins，task 6；从 ExecutionPanel.tsx 拆出；
 *  change: adopt-radix-remaining-canvas-ui：模型菜单迁移到受控 DropdownMenu（radio 语义），
 *  设置面板迁移到受控 Popover —— 设置面板内含表单控件，不能使用 `role="menu"`）。
 *
 * 菜单 open 状态受控，由 `ExecutionPanel` 汇总为 `localOverlayOpen`，用于让面板级 Escape
 * 路由知道是否有更内层浮层（design D7）。浮层 dismiss 由 primitive 承担。
 */
import { ChevronDownIcon, Popover } from "@woohaa3/ui";
import { hiddenBy, summarize } from "./panel-shared.js";
import { ParameterField } from "./parameter-field.js";
import type { ExecutionPanelParameterField } from "./types.js";

export { AssistantListSelector as ModelSelector } from "@woohaa3/ui/assistant";

export function SettingsMenu({
	fields,
	parameters,
	open,
	onOpenChange,
	onChange,
}: {
	fields: ReadonlyArray<ExecutionPanelParameterField>;
	parameters: Record<string, unknown>;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onChange: (next: Record<string, unknown>) => void;
}) {
	const visible = fields.filter((field) => !hiddenBy(field, parameters));
	const summary = summarize(fields, parameters);
	return (
		<div className="mc-panel__settings">
			<Popover
				open={open}
				onOpenChange={onOpenChange}
				side="top"
				align="start"
				className="mc-panel__settings-menu"
				trigger={
					<button
						type="button"
						className="mc-panel__settings-trigger"
						aria-label="生成参数"
						title={summary || "生成参数"}
						aria-haspopup="dialog"
						aria-expanded={open}
					>
						<span className="mc-panel__settings-summary">{summary || "生成参数"}</span>
						<span aria-hidden="true" data-chevron={open ? "open" : undefined}>
							<ChevronDownIcon className="mc-panel__chevron" />
						</span>
					</button>
				}
			>
				{visible.map((field) => (
					<ParameterField
						key={field.key}
						field={field}
						value={parameters[field.key]}
						onChange={(value) => onChange({ [field.key]: value })}
					/>
				))}
			</Popover>
		</div>
	);
}
