/**
 * 参数控件
 * （change: 2026-09-28-split-frontend-god-plugins，task 6；从 ExecutionPanel.tsx 拆出）。
 */
import { useLayoutEffect, useRef } from "react";
import { AdaptiveRatioIcon, ChevronDownIcon } from "../icons/index.js";
import { SearchSelect } from "./search-select.js";
import { PREFERRED_ASPECT_RATIOS } from "@woohaa3/contracts";
import {


	SegmentedControl
} from "../primitives/index.js";
import type { GenerationParameterField as ExecutionPanelParameterField } from "./generation-parameters.js";

export function ParameterField({
	field,
	value,
	onChange,
	lockedBy,
}: {
	field: ExecutionPanelParameterField;
	value: unknown;
	onChange: (value: unknown) => void;
	/** 该字段被别的字段锁定时，给出锁定者的标题（用于解释「为什么不能改」）。 */
	lockedBy?: string;
}) {
	const resolved = value ?? field.defaultValue ?? "";

	if (field.type === "boolean") {
		return (
			<label className="mc-panel__settings-group">
				<span className="mc-panel__settings-label">{field.label}</span>
				<input
					type="checkbox"
					className="generation-parameters__switch" disabled={lockedBy !== undefined} checked={resolved === true}
					onChange={(event) => onChange(event.target.checked)}
				/>
			</label>
		);
	}

	if (
		field.control === "slider" &&
		typeof field.minimum === "number" &&
		typeof field.maximum === "number" &&
		typeof field.step === "number"
	) {
		const numeric = Number(resolved);
		const current = Number.isFinite(numeric)
			? Math.min(field.maximum, Math.max(field.minimum, numeric))
			: field.minimum;
		return (
			<div className="mc-panel__settings-group mc-panel__duration">
				<span className="mc-panel__settings-label">{field.label}</span>
				<div className="mc-panel__duration-control">
					<input
						type="range"
						min={field.minimum}
						max={field.maximum}
						step={field.step}
						value={current}
						aria-label={field.label}
						onChange={(event) => onChange(Number(event.target.value))}
					/>
                    <input className="generation-parameters__numeric" type="number" value={String(resolved)} min={field.minimum} max={field.maximum} step={field.step ?? "any"} disabled={lockedBy !== undefined} onChange={e => onChange(e.target.value === "" ? "" : Number(e.target.value))} />
				</div>
				<div className="mc-panel__duration-bounds" aria-hidden="true">
					<span>
						{field.minimum}
						{field.unit ?? ""}
					</span>
					<span>
						{field.maximum}
						{field.unit ?? ""}
					</span>
				</div>
			</div>
		);
	}

	if (field.type === "select") {
		const options = field.options ?? [];
		// 音色是长列表（几十到上百个上游 id），分段按钮会铺满半屏；用原生下拉更合适。
		// 仍由 `x-pptask-control: "voice"` 显式声明语义，不按 key 名猜。
		if (field.semantic !== "aspect-ratio" && !options.every(o => aspectRatio(o.value) !== null || isAdaptiveValue(o.value)) && (options.length > 5 || options.some(o => o.label.length > 12) || field.presentation?.control === "search-select")) {
            return <SearchSelect label={field.label} options={options} value={String(resolved)} onChange={onChange} disabled={lockedBy !== undefined} lockedBy={lockedBy} />;
		}
		const ratioCount = options.filter((option) => aspectRatio(option.value) !== null).length;
		const adaptiveCount = options.filter((option) => isAdaptiveValue(option.value)).length;
		const ratioCatalog = ratioCount > 0 && ratioCount + adaptiveCount === options.length;
		// 有 `x-pptask-control: aspect-ratio` 的目录直接走参考布局；未声明语义时保留原有
		// 「枚举全为比例（可含自适应）且能撑满一行」的启发式，避免旧 Provider 退化。
		if (
			field.semantic === "aspect-ratio" ||
			(ratioCatalog && (adaptiveCount > 0 || options.length > 4))
		) {
			return <AspectRatioField field={field} value={String(resolved)} onChange={onChange} />;
		}
		// 分辨率档位固定等宽铺满一行（弹层 320px 不溢出）；其它 select 维持换行分段。
		const segmentedClassName =
			field.semantic === "resolution"
				? "mc-panel__settings-row mc-panel__resolution-options"
				: "mc-panel__settings-row mc-panel__settings-row--wrap";
		return (
			<div className="mc-panel__settings-group" data-locked-by={lockedBy}>
				<span className="mc-panel__settings-label">
					{field.label}
					{lockedBy !== undefined ? (
						<span className="mc-panel__settings-lock">由「{lockedBy}」决定</span>
					) : null}
				</span>
				<SegmentedControl
					className={segmentedClassName}
					optionClassName="mc-panel__settings-option"
					label={field.label}
					value={String(resolved)}
					onValueChange={(next) => onChange(next)}
					options={(field.options ?? []).map((option) => ({
						value: option.value,
						label: option.label,
						ariaLabel: option.label,
						// 被联动锁定时整个组不可点：改回来只会产生「选了又被覆盖」的抖动。
						...(lockedBy !== undefined ? { disabled: true } : {})
					}))}
				/>
			</div>
		);
	}

	if (field.type === "textarea") {
		return (
			<label className="mc-panel__settings-group">
				<span className="mc-panel__settings-label">{field.label}</span>
				<textarea
					value={String(resolved)}
					onChange={(event) => onChange(event.target.value)}
				/>
			</label>
		);
	}

	return (
		<label className="mc-panel__settings-group">
			<span className="mc-panel__settings-label">{field.label}</span>
			<input
				type={field.type === "number" ? "number" : "text"}
                disabled={lockedBy !== undefined}
                min={field.minimum} max={field.maximum} step={field.integer ? 1 : field.step ?? "any"}
				value={String(resolved)}
				onChange={(event) =>
					onChange(
						field.type === "number" && event.target.value !== "" ? Number(event.target.value) : event.target.value,
					)
				}
			/>
		</label>
	);
}

function aspectRatio(value: string): number | null {
	const match = value.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
	if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) return null;
	return Number(match[1]) / Number(match[2]);
}

/** provider 用 `auto` / `adaptive` 表达「自适应」，label 仍由 provider 提供。 */
function isAdaptiveValue(value: string): boolean {
	const normalized = value.trim().toLowerCase();
	return normalized === "auto" || normalized === "adaptive";
}

type RatioOption = { value: string; label: string };

/** 预览矩形的最大边长（px）；按真实宽高比缩放，避免撑破 320px 弹层。 */
const RATIO_PREVIEW_MAX = 20;
const RATIO_PREVIEW_MIN = 6;

function ratioPreviewSize(ratio: number): { width: number; height: number } {
	return ratio >= 1
		? {
				width: RATIO_PREVIEW_MAX,
				height: Math.max(RATIO_PREVIEW_MIN, Math.round(RATIO_PREVIEW_MAX / ratio))
			}
		: {
				width: Math.max(RATIO_PREVIEW_MIN, Math.round(RATIO_PREVIEW_MAX * ratio)),
				height: RATIO_PREVIEW_MAX
			};
}

/**
 * 常用比例最多 5 个（4 列网格 + 第二行一个）；顺序取自 contracts 的
 * `PREFERRED_ASPECT_RATIOS`，不足时按 provider 顺序补足，
 * 当前选中的非常用比例替换掉最后一个常用位，保证选中项始终可见。
 */
function commonRatioOptions(
	ratioOptions: readonly RatioOption[],
	value: string,
	adaptive: RatioOption | undefined
): RatioOption[] {
	const common: RatioOption[] = [];
	const push = (option: RatioOption | undefined) => {
		if (option && !common.some((entry) => entry.value === option.value)) common.push(option);
	};
	for (const ratio of PREFERRED_ASPECT_RATIOS) {
		push(ratioOptions.find((option) => option.value === ratio));
	}
	for (const option of ratioOptions) {
		if (common.length >= PREFERRED_ASPECT_RATIOS.length) break;
		push(option);
	}
	if (value !== adaptive?.value) {
		const selected = ratioOptions.find((option) => option.value === value);
		if (selected && !common.some((entry) => entry.value === selected.value)) {
			if (common.length === 0) common.push(selected);
			else common[common.length - 1] = selected;
		}
	}
	return common;
}

/** 比例瓦片：矩形预览（按真实宽高比）+ 比例文字。 */
function RatioTiles({ options, value, onSelect, label }: {
	options: readonly RatioOption[];
	value: string;
	onSelect: (value: string) => void;
	label?: string;
}) {
	return (
		<div className="mc-panel__ratio-options" role="group" aria-label={label}>
			{options.map((option) => {
				const ratio = aspectRatio(option.value);
				return (
					<button
						key={option.value}
						type="button"
						className="mc-panel__ratio-tile"
						data-state={value === option.value ? "on" : "off"}
						aria-label={option.label}
						onClick={() => onSelect(option.value)}
					>
						{ratio !== null ? (
							<span
								className="mc-panel__ratio-preview"
								aria-hidden="true"
								style={ratioPreviewSize(ratio)}
							/>
						) : null}
						<span className="mc-panel__ratio-label">{option.label}</span>
					</button>
				);
			})}
		</div>
	);
}

/**
 * 比例字段：左侧「自适应」按钮 + 右侧 4 列比例瓦片；更多比例收进 details。
 * 没有自适应选项时退化为纯 4 列网格。提交值始终是目录原始 option.value。
 */
function AspectRatioField({ field, value, onChange }: {
	field: ExecutionPanelParameterField;
	value: string;
	onChange: (value: unknown) => void;
}) {
	const root = useRef<HTMLDivElement>(null);
	const restoreFocus = useRef(false);
	useLayoutEffect(() => {
		if (restoreFocus.current) root.current?.querySelector<HTMLButtonElement>('button[data-state="on"]')?.focus();
		restoreFocus.current = false;
	}, [value]);
	const select = (next: string) => {
		restoreFocus.current = root.current?.contains(document.activeElement) ?? false;
		onChange(next);
	};
	const options = field.options ?? [];
	// 优先用 contracts 的 `x-pptask-adaptive` 标记；旧 Provider 没有标记时按 auto/adaptive 兜底。
	const adaptive =
		options.find((option) => option.value === field.adaptiveValue) ??
		options.find((option) => isAdaptiveValue(option.value));
	// 部分 provider 直接拿取值当 label（如 video 的 `adaptive`）；统一显示中文。
	const adaptiveLabel = adaptive && adaptive.label.trim().toLowerCase() === adaptive.value.trim().toLowerCase()
		? "自适应"
		: adaptive?.label;
	const ratioOptions = options.filter((option) => aspectRatio(option.value) !== null);
	const common = commonRatioOptions(ratioOptions, value, adaptive);
	const more = options.filter(
		(option) => option !== adaptive && !common.some((entry) => entry.value === option.value)
	);
	return (
		<div ref={root} className="mc-panel__settings-group mc-panel__ratio-field">
			<span className="mc-panel__settings-label">{field.label}</span>
			<div className={`mc-panel__ratio-layout${adaptive ? "" : " mc-panel__ratio-layout--grid-only"}`}>
				{adaptive ? (
					<button
						type="button"
						className="mc-panel__ratio-adaptive"
						data-state={value === adaptive.value ? "on" : "off"}
						aria-label={adaptiveLabel}
						onClick={() => select(adaptive.value)}
					>
						<AdaptiveRatioIcon className="mc-panel__ratio-adaptive-icon" />
						<span className="mc-panel__ratio-label">{adaptiveLabel}</span>
					</button>
				) : null}
				<RatioTiles options={common} value={value} onSelect={select} label={field.label} />
			</div>
			{more.length > 0 ? (
				<details className="mc-panel__more-ratios">
					<summary>更多比例（{more.length}）<ChevronDownIcon className="mc-panel__chevron" /></summary>
					<RatioTiles
						options={more}
						value={value}
						onSelect={select}
						label={`${field.label}，更多比例`}
					/>
				</details>
			) : null}
		</div>
	);
}
