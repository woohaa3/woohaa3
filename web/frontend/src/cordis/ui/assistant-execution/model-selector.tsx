import type { ComponentProps } from "react";
import { ChevronDownIcon, DiamondIcon, DropdownMenu, DropdownMenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator } from "../../../shared/ui/index.js";
import "./model-selector.css";

export const ASSISTANT_SETUP_HINT = "尚未配置助手。连接一个助手即可开始，创作描述会保留在这里。";
export const ASSISTANT_SETUP_TOOLTIP = "尚未配置助手，点击这里配置。";

/** All assistant entry points share selection and the first-connection action. */
export function AssistantConnectionSelector({ empty, loading, ...props }: Omit<ComponentProps<typeof AssistantModelSelector>, "label"> & { empty: boolean; loading?: boolean }) {
	if (empty && props.onManage) return (
		<div className="mc-panel__model assistant-model-selector">
			<button type="button" className="mc-panel__model-trigger" disabled={props.disabled} onClick={props.onManage}>
				<DiamondIcon className="mc-panel__model-icon" />
				<span className="mc-panel__model-label">配置助手</span>
			</button>
		</div>
	);
	return <AssistantModelSelector {...props} label="选择助手" placeholder={loading ? "正在读取助手…" : props.placeholder ?? "选择助手"} />;
}

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
}: {
	model: string;
	options: ReadonlyArray<{ value: string; label: string; detail?: string; provider?: string; disabled?: boolean }>;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onChange: (model: string) => void;
	label?: string;
	placeholder?: string;
	disabled?: boolean;
	onManage?: () => void;
	keepOpenOnModelSelect?: boolean;
	variant?: {
		value: string;
		options: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>;
		onChange: (value: string) => void;
	};
}) {
	const selected = options.find((option) => option.value === model);
	const variantLabel = variant?.options.find(option => option.value === variant.value)?.label;
	const summary = [selected?.label || model || placeholder || label, variantLabel].filter(Boolean).join(" · ");
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
				<MenuRadioGroup value={model} onValueChange={value => {
					if (disabled) return;
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
				</MenuRadioGroup>
				{variant ? <>
					<MenuSeparator className="ui-menu__separator" />
					<div className="mc-panel__model-section">Variant</div>
					<MenuRadioGroup value={variant.value} onValueChange={value => {
						if (disabled) return;
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

