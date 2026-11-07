import { useEffect, useState, type ComponentProps } from "react";
import {
	DropdownMenu,
	DropdownMenuItem,
	MenuEntry,
	MenuRadioGroup,
	MenuRadioItem,
	MenuSeparator,
	Popover,
} from "../primitives/index.js";
import { Button } from "../primitives/Button.js";
import { SearchIcon } from "../icons/index.js";

export const ASSISTANT_SETUP_HINT = "尚未配置助手。连接一个助手即可开始，创作描述会保留在这里。";
export const ASSISTANT_SETUP_TOOLTIP = "尚未配置助手，点击这里配置。";

/** 目录较长时才占用一行放搜索框；短列表直接给选项，少一次点击。 */
const MODEL_SEARCH_THRESHOLD = 8;

type SelectorOption = { value: string; label: string; detail?: string; provider?: string; group?: string; disabled?: boolean };
const UNGROUPED_LABEL = "其他";

/**
 * 按 `group` 归并成二级菜单：一级是系列，二级是该系列下的具体模型。
 * 保持首次出现的顺序；没有 group 的归到「其他」。只有一个分组时没必要多一层，返回 undefined。
 */
function groupOptions(options: ReadonlyArray<SelectorOption>): Array<{ name: string; options: SelectorOption[] }> | undefined {
	const groups = new Map<string, SelectorOption[]>();
	for (const option of options) {
		const name = option.group ?? UNGROUPED_LABEL;
		const list = groups.get(name);
		if (list) list.push(option);
		else groups.set(name, [option]);
	}
	if (groups.size < 2) return undefined;
	return [...groups].map(([name, list]) => ({ name, options: list }));
}
type SelectorVariant = {
	/** 可为空串（「默认 Variant」），因此不能交给忽略空值的单选分段控件。 */
	value: string;
	options: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>;
	onChange: (value: string) => void;
};

type SelectorProps = {
	model: string;
	options: ReadonlyArray<SelectorOption>;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onChange: (model: string) => void;
	label?: string;
	placeholder?: string;
	disabled?: boolean;
	onManage?: () => void;
	keepOpenOnModelSelect?: boolean;
	variant?: SelectorVariant;
};

/**
 * 助手入口共用同一个选择与首次配置动作。
 *
 * 连接是整份用户助手目录，条目多且各带不可用原因，仍用单列菜单；模型与 Variant 走
 * `AssistantModelSelector` 的横向选项面板，与图片节点参数面板的排布一致。
 */
export function AssistantConnectionSelector({ empty, loading, ...props }: Omit<ComponentProps<typeof AssistantListSelector>, "label"> & { empty: boolean; loading?: boolean }) {
	if (empty && props.onManage) return (
		<div className="mc-panel__model assistant-model-selector">
			<button type="button" className="mc-panel__model-trigger" disabled={props.disabled} onClick={props.onManage}>
				<DiamondIcon className="mc-panel__model-icon" />
				<span className="mc-panel__model-label">配置助手</span>
			</button>
		</div>
	);
	return <AssistantListSelector {...props} label="选择助手" placeholder={loading ? "正在读取助手…" : props.placeholder ?? "选择助手"} />;
}

/** 单列菜单式选择：助手连接与节点生成模型这类长列表继续用它。 */
export function AssistantListSelector({
	model,
	options,
	open,
	onOpenChange,
	onChange,
	label = "选择生成模型",
	placeholder,
	disabled = false,
	onManage,
	variant,
	keepOpenOnModelSelect = false,
}: SelectorProps) {
	const selected = options.find((option) => option.value === model);
	const variantLabel = variant?.options.find(option => option.value === variant.value)?.label;
	const summary = [selected?.label || model || placeholder || label, variantLabel].filter(Boolean).join(" · ");
	// 带 Variant 的菜单要在同一面板里接着选 Variant，保持单列；只有纯模型列表才分二级。
	const grouped = variant ? undefined : groupOptions(options);
	return (
		<div className="mc-panel__model assistant-model-selector">
			<DropdownMenu
				label={label}
				open={open && !disabled}
				onOpenChange={(next) => onOpenChange(next && !disabled)}
				className="mc-panel__model-menu assistant-model-menu"
				align="start"
				side="top"
				trigger={
					<button
						type="button"
						className="mc-panel__model-trigger"
						aria-label={label}
						disabled={disabled}
						title={summary}
						aria-haspopup="menu"
						aria-expanded={open && !disabled}
					>
						<DiamondIcon className="mc-panel__model-icon" />
						<span className="mc-panel__model-label">{summary}</span>
						<span aria-hidden="true" data-chevron={open ? "open" : undefined}>
							<ChevronDownIcon className="mc-panel__chevron" />
						</span>
					</button>
				}
			>
				{grouped ? grouped.map(group => (
					<MenuEntry
						key={group.name}
						item={{
							id: `group:${group.name}`,
							label: <span className="mc-panel__model-name">{group.name}</span>,
							onSelect: () => undefined,
							children: group.options.map(option => ({
								id: option.value,
								label: <>
									<span className="mc-panel__model-name">{option.label}</span>
									{option.detail ? <span className="mc-panel__model-provider">{option.detail}</span> : null}
								</>,
								selected: option.value === model,
								disabled: disabled || option.disabled,
								onSelect: value => {
									if (disabled) return;
									onChange(value);
									if (!keepOpenOnModelSelect) onOpenChange(false);
								}
							}))
						}}
					/>
				)) : <MenuRadioGroup value={model} onValueChange={value => {
					if (disabled || !options.some(option => option.value === value && !option.disabled)) return;
					onChange(value);
					if (!keepOpenOnModelSelect && !variant) onOpenChange(false);
				}}>
				{options.map((option) => (
					<MenuRadioItem
						key={option.value}
						value={option.value}
						active={option.value === model}
						disabled={disabled || option.disabled}
						label={option.label}
						onSelect={event => { if (keepOpenOnModelSelect || variant) event.preventDefault(); }}
					>
						<span className="mc-panel__model-name">{option.label}</span>
                        {option.detail ? <span className="mc-panel__model-provider">{option.detail}</span> : null}
						{option.provider ? <span className="mc-panel__model-provider">提供方 {option.provider}</span> : null}
					</MenuRadioItem>
				))}
				</MenuRadioGroup>}
					{variant ? <>
					<MenuSeparator className="ui-menu__separator" />
					<div className="mc-panel__model-section">Variant</div>
					<MenuRadioGroup value={variant.value} onValueChange={value => {
						if (disabled || !variant.options.some(option => option.value === value && !option.disabled)) return;
						variant.onChange(value);
						onOpenChange(false);
					}}>
						{variant.options.map(option => <MenuRadioItem key={option.value} value={option.value}
							active={option.value === variant.value} disabled={disabled || option.disabled}
							label={option.label} onSelect={() => undefined}>{option.label}</MenuRadioItem>)}
					</MenuRadioGroup>
				</> : null}
				{onManage ? <DropdownMenuItem onSelect={onManage}>管理助手</DropdownMenuItem> : null}
			</DropdownMenu>
		</div>
	);
}

/**
 * 模型与 Variant 的参数面板。
 *
 * 与图片节点参数面板一致：选项横向排开、按可用宽度换行，而不是每个选项占一行的下拉菜单。
 * 一次展开即可完成两项选择——选模型保持展开，便于继续选该模型真实支持的 Variant；
 * 选定 Variant 后收起。选项文案、禁用原因仍来自调用方，不在这里推断能力。
 */
export function AssistantModelSelector({
	model,
	options,
	open,
	onOpenChange,
	onChange,
	label = "选择生成模型",
	placeholder,
	disabled = false,
	onManage,
	variant,
	keepOpenOnModelSelect = false,
}: SelectorProps) {
	const selected = options.find((option) => option.value === model);
	const variantLabel = variant?.options.find(option => option.value === variant.value)?.label;
	const summary = [selected?.label || model || placeholder || label, variantLabel].filter(Boolean).join(" · ");
	const expanded = open && !disabled;
	// 目录可能是上百个模型（本机工具会合并多个 provider），只按 label 逐项扫视不可用；
	// 超过阈值时提供即时过滤，匹配模型名、来源说明与 provider 名。
	const searchable = options.length > MODEL_SEARCH_THRESHOLD;
	const [query, setQuery] = useState("");
	useEffect(() => { if (!expanded) setQuery(""); }, [expanded]);
	const needle = query.trim().toLocaleLowerCase();
	const visibleOptions = needle
		? options.filter(option => [option.label, option.detail, option.provider].filter(Boolean).join(" ").toLocaleLowerCase().includes(needle))
		: options;
	return (
		<div className="mc-panel__model assistant-model-selector">
			<Popover
				open={expanded}
				onOpenChange={(next) => onOpenChange(next && !disabled)}
				className="assistant-model-panel"
				label={label}
				align="start"
				side="top"
				trigger={
					<button
						type="button"
						className="mc-panel__model-trigger"
						aria-label={label}
						disabled={disabled}
						title={summary}
						aria-haspopup="dialog"
						aria-expanded={expanded}
						onKeyDown={event => {
							// 原生 button 只在浏览器里把 Enter/Space 合成为 click；这里显式展开，
							// 让键盘、读屏合成与鼠标点击都走同一条路径（已展开时交给浮层处理）。
							if (expanded) return;
							if (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowDown") return;
							event.preventDefault();
							onOpenChange(true);
						}}
					>
						<DiamondIcon className="mc-panel__model-icon" />
						<span className="mc-panel__model-label">{summary}</span>
						<span aria-hidden="true" data-chevron={expanded ? "open" : undefined}>
							<ChevronDownIcon className="mc-panel__chevron" />
						</span>
					</button>
				}
			>
				{searchable ? (
					<div className="assistant-model-panel__searchbar">
						<label className="assistant-model-panel__search">
							<SearchIcon className="assistant-model-panel__search-icon" />
							<input
								type="search"
								value={query}
								placeholder="搜索模型或 provider"
								aria-label="搜索模型"
								autoComplete="off"
								onChange={event => setQuery(event.target.value)}
							/>
						</label>
					</div>
				) : null}
				<OptionChips
					label="模型"
					groupLabel={label}
					value={model}
					disabled={disabled}
					empty={needle ? "没有匹配的模型" : undefined}
					options={visibleOptions.map(option => ({
						value: option.value,
						label: option.label,
						note: option.detail ?? (option.provider ? `提供方 ${option.provider}` : undefined),
						disabled: option.disabled,
					}))}
					onSelect={value => {
						if (disabled) return;
						onChange(value);
						if (!keepOpenOnModelSelect && !variant) onOpenChange(false);
					}}
				/>
				{variant ? (
					<OptionChips
						label="Variant"
						value={variant.value}
						disabled={disabled}
						options={variant.options}
						onSelect={value => {
							if (disabled) return;
							variant.onChange(value);
							onOpenChange(false);
						}}
					/>
				) : null}
				{onManage ? (
					<Button
						size="sm"
						tone="ghost"
						className="assistant-model-panel__manage"
						onClick={() => { onOpenChange(false); onManage(); }}
					>
						管理助手
					</Button>
				) : null}
			</Popover>
		</div>
	);
}

/**
 * 横向选项行：标题 + 一排可换行的 chip。
 *
 * 用普通按钮而不是单选分段控件，因为 Variant 的真实取值可以是空串（「默认 Variant」），
 * 而 `SegmentedControl` 的单选模式会忽略空值、无法表达该选项。
 */
function OptionChips({ label, groupLabel, value, disabled, options, empty, onSelect }: {
	label: string;
	/** 与面板触发器同名时作为组名，读屏与测试可定位。 */
	groupLabel?: string;
	value: string;
	disabled: boolean;
	options: ReadonlyArray<{ value: string; label: string; note?: string; disabled?: boolean }>;
	/** 过滤后没有任何选项时的提示。 */
	empty?: string;
	onSelect: (value: string) => void;
}) {
	return (
		<div className="assistant-model-panel__group">
			<span className="assistant-model-panel__label">{label}</span>
			<div className="assistant-model-panel__options" role="group" aria-label={groupLabel ?? label}>
				{options.length === 0 && empty ? <span className="assistant-model-panel__empty">{empty}</span> : null}
				{options.map(option => (
					<button
						key={option.value}
						type="button"
						className="assistant-model-panel__option"
						data-state={option.value === value ? "on" : "off"}
						aria-pressed={option.value === value}
						aria-label={option.label}
						title={option.note}
						disabled={disabled || option.disabled}
						onClick={() => onSelect(option.value)}
					>
						<span className="assistant-model-panel__option-label">{option.label}</span>
						{option.note ? <span className="assistant-model-panel__option-note">{option.note}</span> : null}
					</button>
				))}
			</div>
		</div>
	);
}

import { ChevronDownIcon, DiamondIcon } from "../icons/index.js";
