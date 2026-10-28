/**
 * Dock 面的左侧模型导航
 * （change: 2026-09-28-split-frontend-god-plugins，task 6；从 ExecutionPanel.tsx 拆出）。
 *
 * 与 `ExecutionPanel` 同属生产组件，保证 showcase 直接组合生产 UX 而不复制 markup
 * （change: align-showcase-reference-ux，design D3 / 任务 2.1）。它只改变“在哪里选模型”，
 * 具体参数、发送、润色仍由 `ExecutionPanel`/宿主负责。
 */
import { useState } from "react";
import { Listbox } from "@woohaa3/ui";

export type ExecutionPanelModelNavProps = {
	/** 模型选项（与 ExecutionPanel modelConfig.modelOptions 同源）。 */
	options: ReadonlyArray<{ value: string; label: string; detail?: string }>;
	/** 当前选中的模型 id。 */
	model: string;
	/** 选择模型。 */
	onSelect: (model: string) => void;
	/** 搜索框 aria-label，默认「搜索模型」。 */
	searchLabel?: string;
};

export function ExecutionPanelModelNav({
	options,
	model,
	onSelect,
	searchLabel = "搜索模型",
}: ExecutionPanelModelNavProps) {
	const [query, setQuery] = useState("");
	const normalized = query.trim().toLowerCase();
	const filtered = normalized
		? options.filter((option) =>
			`${option.label}\n${option.detail ?? ""}`.toLowerCase().includes(normalized),
		)
		: options;

	return (
		<aside className="mc-panel__model-nav" aria-label="生成模型">
			<div className="mc-panel__model-nav-header">
				<span className="mc-panel__model-nav-title">模型</span>
				<label className="mc-panel__model-nav-search">
					<input
						type="search"
						value={query}
						aria-label={searchLabel}
						placeholder="搜索"
						onChange={(event) => setQuery(event.target.value)}
					/>
				</label>
			</div>
			<Listbox
				label="选择生成模型"
				className="mc-panel__model-nav-items"
				optionClassName="mc-panel__model-nav-item"
				value={model}
				onValueChange={onSelect}
				empty={
					<div className="mc-panel__model-nav-empty" role="status">
						没有匹配的模型
					</div>
				}
				options={filtered.map((option) => ({
					value: option.value,
					dataAttributes: { "data-active": option.value === model ? "" : undefined },
					label: (
						<>
							<span className="mc-panel__model-nav-marker" aria-hidden="true" />
							<span className="mc-panel__model-nav-copy">
								<strong>{option.label}</strong>
								{option.detail ? <small>{option.detail}</small> : null}
							</span>
						</>
					)
				}))}
			/>
		</aside>
	);
}
