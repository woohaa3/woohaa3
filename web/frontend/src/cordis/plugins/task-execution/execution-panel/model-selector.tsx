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

/**
 * 联动锁定：哪些字段被别的字段的当前取值强制成了某个值。
 *
 * 例如「透明背景」要求 `outputFormat: png`：用户选了透明，格式字段就被锁在 PNG。
 * 面板据此把该控件置为禁用并说明原因——**不隐藏**：隐藏会让人以为这个参数消失了，
 * 锁定加一句「由『背景』决定」才是可解释的。
 */
function lockedFields(
	fields: ReadonlyArray<ExecutionPanelParameterField>,
	parameters: Record<string, unknown>
): Map<string, { byLabel: string; value: unknown }> {
	const locked = new Map<string, { byLabel: string; value: unknown }>();
	for (const field of fields) {
		const requires = field.requiresByValue?.[String(parameters[field.key] ?? "")];
		if (requires === undefined) continue;
		for (const [target, forced] of Object.entries(requires)) {
			locked.set(target, { byLabel: field.label, value: forced });
		}
	}
	return locked;
}

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
	const locked = lockedFields(visible, parameters);
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
				{visible.map((field) => {
					const lock = locked.get(field.key);
					return (
						<ParameterField
							key={field.key}
							field={field}
							value={parameters[field.key]}
							{...(lock !== undefined ? { lockedBy: lock.byLabel } : {})}
							onChange={(value) => {
								// 选中带联动的选项时**一次写入两个字段**：目标先被改写，用户不会看到
								// 「格式还是 JPEG、背景已经是透明」的中间态。
								const requires = field.requiresByValue?.[String(value)] ?? {};
								onChange({ ...requires, [field.key]: value });
							}}
						/>
					);
				})}
			</Popover>
		</div>
	);
}