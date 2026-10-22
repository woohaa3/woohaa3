import { useState } from "react";
import {
	ExecutionPanel,
	ExecutionPanelModelNav,
	IMAGE_MODEL_CONFIG,
	type ExecutionPanelData,
	type ExecutionPanelRunSnapshot,
} from "../../frontend/src/cordis/ui/index";

/**
 * Dock 的稳定模型 fixture（change: align-showcase-reference-ux，design D3 / 任务 2.1）。
 *
 * 从生产 `IMAGE_MODEL_CONFIG` 派生，避免与组件内模型目录漂移；额外补可搜索命中的
 * 模型，让「搜索 → 无结果」场景稳定复现。
 */
export const DOCK_MODEL_CONFIG = {
	...IMAGE_MODEL_CONFIG,
	modelOptions: [
		{ value: "seedream-5-pro", label: "即梦 5.0 Pro", detail: "写实 / 高速" },
		{ value: "gemini-3.1-flash-image", label: "Gemini 3.1 Flash Image", detail: "多模态 / 编辑" },
		{ value: "qwen-image-3", label: "通义万相 3", detail: "中文语义" },
	],
} as const;

const BASE_DATA: ExecutionPanelData = {
	title: "主视觉图",
	panelPrompt: "薄雾森林中的旅行者，电影感光影。",
	taskStatus: "idle",
	parameters: { model: "seedream-5-pro", ratio: "1:1", resolution: "1K" },
};

/**
 * Dock 分栏实体：左侧生产 `ExecutionPanelModelNav` + 右侧生产 `ExecutionPanel`。
 *
 * Dock 内不重复 inline 模型选择 / 发送 / 润色（任务 2.2）；执行放到宿主级 action 区，
 * 通过生产 `onRun` 契约提交快照。
 */
export function DockDeck({
	narrow = false,
	onRun,
}: {
	narrow?: boolean;
	onRun?: (snapshot: ExecutionPanelRunSnapshot) => void;
}) {
	const [model, setModel] = useState<string>(DOCK_MODEL_CONFIG.defaultModel);
	const [data, setData] = useState<ExecutionPanelData>(BASE_DATA);
	const [dockView, setDockView] = useState<"models" | "editor">(narrow ? "models" : "editor");
	const [lastRun, setLastRun] = useState<ExecutionPanelRunSnapshot | null>(null);

	const selectModel = (next: string) => {
		setModel(next);
		setData((current) => ({
			...current,
			parameters: {
				...(current.parameters ?? {}),
				model: next,
				...(DOCK_MODEL_CONFIG.defaultsByModel?.[next] ?? {}),
			},
		}));
		if (narrow) setDockView("editor");
	};

	return (
		<div
			className={`mc-panel__dock-layout${narrow ? " is-narrow" : ""}`}
			data-dock-view={dockView}
		>
			<ExecutionPanelModelNav
				options={DOCK_MODEL_CONFIG.modelOptions}
				model={model}
				onSelect={selectModel}
			/>
			<div className="mc-panel__dock-content">
				{narrow ? (
					<button
						type="button"
						className="mc-panel__dock-back"
						onClick={() => setDockView("models")}
					>
						← 模型列表
					</button>
				) : null}
				<ExecutionPanel
					taskKind="image-generation"
					modelConfig={DOCK_MODEL_CONFIG}
					data={data}
					surface="dock"
					showModelSelector={false}
					showRun={false}
					showPolish={false}
					onChange={(patch) => setData((current) => ({ ...current, ...patch }))}
					onRun={(snapshot) => {
						setLastRun(snapshot);
						onRun?.(snapshot);
					}}
				/>
			</div>
			{/* 宿主级 action：执行快照仍走生产 `onRun` 契约（任务 2.2）。 */}
			<div className="dock-deck__host-actions" aria-label="宿主执行动作">
				<button
					type="button"
					className="dlg__button dlg__button--primary"
					data-testid="host-run"
					onClick={() => {
						const snapshot = {
							prompt: data.panelPrompt ?? "",
							model,
							parameters: { ...(data.parameters ?? {}), model },
						};
						setLastRun(snapshot);
						onRun?.(snapshot);
					}}
				>
					执行生成
				</button>
				{lastRun ? (
					<pre className="showcase__hint" data-testid="dock-last-run">
						{JSON.stringify(lastRun, null, 2)}
					</pre>
				) : null}
			</div>
		</div>
	);
}
