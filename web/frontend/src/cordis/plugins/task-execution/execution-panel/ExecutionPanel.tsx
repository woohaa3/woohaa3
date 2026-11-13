/**
 * 执行面板：节点聚焦时的生成/编辑界面。
 *
 * 任务编辑面板的结构：
 *  头部  参考区 + 展开/收起
 *  内容  提示词输入
 *  参数  模型选择 + 参数菜单
 *  底部  快捷改写 + 执行
 *
 * 子视图与控件拆到同级模块（change: 2026-09-28-split-frontend-god-plugins，task 6）：
 * `panel-views`（header/prompt/run/blocking/video-edit）、`format-toolbar`、
 * `model-selector`、`parameter-field`、`error-inspector`、`model-nav`、`panel-shared`。
 */
import {
	type CSSProperties,
	type ReactNode,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	DEFAULT_MODEL_CONFIG_BY_KIND,
	type ExecutionPanelData,
	type ExecutionPanelProps,
	type ExecutionPanelSkill,
	type ExecutionPanelStatus,
	type ExecutionPanelTaskKind,
} from "./types.js";
import {
	canRunExecution,
	executionRunSnapshot,
	isExecutionBusy,
} from "./run-snapshot.js";
import { isBusy, missingRequiredParameters, parametersAfterModelSwitch, parametersOnOpen, parameterViolationReasons, readParameters } from "./panel-shared.js";
import { resolvePromptSubmitKey } from "../prompt-keyboard.js";
import { isMacPlatform } from "../../canvas-shell/input/shortcuts.js";
import { FormatToolbar } from "./format-toolbar.js";
import { ModelSelector, SettingsMenu } from "./model-selector.js";
import {
	BlockingBlock,
	PanelHeader,
	PromptBox,
	RunActions,
	ExecutionStatus,
	AgentDetailBlock,
	VideoEditEntryBlock,
} from "./panel-views.js";
import "./execution-panel.css";

export { ExecutionPanelModelNav } from "./model-nav.js";
export type { ExecutionPanelModelNavProps } from "./model-nav.js";

export type ExecutionPanelShellProps = {
	children: ReactNode;
	ariaLabel: string;
	className?: string;
};

/** 与任务执行面板共享同一套 dock 宿主、边框、背景和阴影的自定义内容壳。 */
export function ExecutionPanelShell({ children, ariaLabel, className }: ExecutionPanelShellProps) {
	return (
		<div className="mc-panel__host" data-surface="dock">
			<div
				className={`mc-panel${className ? ` ${className}` : ""}`}
				data-surface="dock"
				role="region"
				aria-label={ariaLabel}
			>
				{children}
			</div>
		</div>
	);
}

/** 内置快捷改写技能，对齐原工程 PROMPT_SKILLS。 */
const DEFAULT_SKILLS: ExecutionPanelSkill[] = [
	{ id: "polish", label: "画面细节润色", description: "补全主体、构图、镜头、光影与氛围" },
	{ id: "translate", label: "中英双向翻译", description: "等价转换，保留参数和视觉关键词" },
	{ id: "structure", label: "提示词分层整理", description: "整理主体、场景、镜头、光影和风格" },
	{ id: "style-transfer", label: "视觉风格迁移", description: "保留主体构图，切换统一视觉风格" },
	{ id: "loop-frame", label: "Loop 帧生成", description: "读取参考图，生成可无缝循环的低频动态提示词" },
];

const STATUS_LABEL: Record<ExecutionPanelStatus, string> = {
	idle: "待生成",
	pending: "排队中",
	processing: "生成中",
	materializing: "媒体准备中",
	successed: "已完成",
	failed: "失败",
};

const TASK_LABEL: Record<ExecutionPanelTaskKind, string> = {
	"text-generation": "文本",
	"image-generation": "图片",
	"video-generation": "视频",
	"audio-generation": "音频",
};

export function ExecutionPanel({
	taskKind,
	modelConfig,
	data = {},
	surface = "canvas",
	runLabel,
	pendingLabel = "生成中",
	showExpand = true,
	showModelSelector = true,
    modelSelectorSlot,
	showRun = true,
	showPolish = true,
	showFormatToolbar = true,
	onFormatCommand,
	presentation = "compact",
	width,
	skills = DEFAULT_SKILLS,
	referencesSlot,
	statusSlot,
	promptEditorSlot,
	onRemoveVideoEditIntent,
	onOpenVideoEdit,
	onOpenVideoFrameCapture,
	videoEditDisabledReason,
	onOpenVideoEditIntent,
	videoEditEntryBlockedReason,
	onPromptSkill,
	blockingReasons,
	readOnly = false,
	allowEmptySubmit = false,
	onChange,
	onRun,
	onViewTask,
	agentDetailAction,
	onViewAgentDetail,
	onExpand,
	onCollapse,
	onClose,
	className,
}: ExecutionPanelProps) {
	const config = modelConfig ?? DEFAULT_MODEL_CONFIG_BY_KIND[taskKind];
	const parameters = readParameters(data.parameters);
	const model =
		config.modelOptions.some((option) => option.value === parameters.model)
			? String(parameters.model)
			: config.defaultModel;
	const fields = config.parameterSchemaByModel?.[model] ?? [];
	const status: ExecutionPanelStatus = data.taskStatus ?? "idle";
	const busy = isBusy(status);
	const actionLabel = runLabel ?? `生成${TASK_LABEL[taskKind]}`;
	const busyLabel = status === "pending" ? "排队中" : pendingLabel;
	// 受控 presentation（design D5）：组件不再持有 expanded 本地权威状态。
	const expanded = presentation === "expanded";

	const [prompt, setPrompt] = useState(data.panelPrompt ?? "");
	const [polishOpen, setPolishOpen] = useState(false);
	const [skillError, setSkillError] = useState<string | null>(null);
	const [activeSkill, setActiveSkill] = useState<string | null>(null);
	const [modelOpen, setModelOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);

	useEffect(() => {
		setPrompt(data.panelPrompt ?? "");
	}, [data.panelPrompt]);

	const visibleSkills = useMemo(
		() => skills.filter((skill) => skill.id !== "loop-frame" || taskKind === "video-generation"),
		[skills, taskKind],
	);

	const hasBlockingReasons = (blockingReasons?.length ?? 0) > 0;
	// 打开面板时把该模型的参数默认值并入草稿（A9）：界面上显示「720p · 5」，
	// 请求体里却可能一个字段都没有。只补缺，不覆盖已有值。
	const effectiveParameters = useMemo(
		() => parametersOnOpen(config, parameters, model),
		[config, parameters, model],
	);
	const missingRequired = missingRequiredParameters(config, effectiveParameters, model);
	const missingRequiredHint = missingRequired.length
		? `缺少必填参数：${missingRequired.map((field) => field.label).join("、")}`
		: undefined;
	const parameterViolations = parameterViolationReasons(fields, effectiveParameters);
	const parameterViolationHint = parameterViolations[0];
	const promptOptional = allowEmptySubmit;
	const canRun =
		!readOnly &&
		missingRequired.length === 0 &&
		parameterViolations.length === 0 &&
		(canRunExecution({ prompt, status, blockingReasons }) ||
			(promptOptional &&
				prompt.trim().length === 0 &&
				!isExecutionBusy(status) &&
				!hasBlockingReasons));
	const disabledHint = readOnly
		? "当前只读，无法生成"
		: busy
			? pendingLabel
			: missingRequiredHint
				? missingRequiredHint
				: parameterViolationHint
					? parameterViolationHint
					: hasBlockingReasons
						? blockingReasons?.[0]
						: !promptOptional && prompt.trim().length === 0
							? "请先输入提示词"
							: undefined;

	const patch = (next: Partial<ExecutionPanelData>) => onChange?.(next);

	const patchParameters = (next: Record<string, unknown>) =>
		patch({ parameters: { ...parameters, model, ...next } });

	function submit() {
		if (!canRun) return;
		// 快照取本地 prompt + 渲染期解析出的 model/参数：父组件状态尚未回流也不影响本次提交。
		// 参数必须带上模型默认值，否则 Provider 会拒一个界面上明明有值的必填字段（A9）。
		onRun?.(executionRunSnapshot({ prompt, model, parameters: effectiveParameters }));
	}

	function runSkill(skill: ExecutionPanelSkill) {
		if (!prompt.trim()) {
			setSkillError("请先输入提示词");
			return;
		}
		// `#` 片段触发默认需工具插件；提供回调时把「所选 action + 当前草稿」交给宿主。
		if (!onPromptSkill) {
			// 原工程在此调用宿主 prompt 工具；这里保留交互与 loading 语义，
			// 改写结果由宿主通过 data.panelPrompt 回流。
			setSkillError("未接入提示词工具插件");
			setActiveSkill(skill.id);
			setTimeout(() => setActiveSkill(null), 700);
			return;
		}
		// 选定即关闭菜单：进行中状态在触发按钮上表达，结果由宿主写回草稿。
		setPolishOpen(false);
		setSkillError(null);
		setActiveSkill(skill.id);
		Promise.resolve(onPromptSkill({ id: skill.id, label: skill.label, prompt }))
			.catch((error: unknown) => {
				setSkillError(error instanceof Error && error.message.trim() ? error.message : "快捷改写失败");
			})
			.finally(() => setActiveSkill(null));
	}

	function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
		const decision = resolvePromptSubmitKey(
			{
				key: event.key,
				ctrlKey: event.ctrlKey,
				metaKey: event.metaKey,
				shiftKey: event.shiftKey,
				altKey: event.altKey,
				repeat: event.nativeEvent.repeat,
				isComposing: event.nativeEvent.isComposing,
				keyCode: event.keyCode
			},
			{
				isMac: isMacPlatform(typeof navigator !== "undefined" ? navigator : undefined),
				readOnly: !!readOnly,
				blocked: hasBlockingReasons || isExecutionBusy(status),
				busy: isExecutionBusy(status),
				candidateMenuOpen: false
			}
		);
		if (decision.action === "submit") {
			event.preventDefault();
			submit();
			return;
		}
		// 换行/输入法/候选交给默认行为，不拦截，也不提交。
	}

	const usesSectioned = expanded || surface === "dock";
	const isAudioTask = taskKind === "audio-generation";
	// 任何一项改写在进行中都展示同一处理中状态（按钮禁用 + 转圈），不区分具体技能。
	const polishProcessing = activeSkill !== null;
	const isVideoEditMode =
		taskKind === "video-generation" && parameters.generationMode === "edit_video";
	const videoEditIntents = isVideoEditMode ? (data.videoEditIntents ?? []) : [];
	const videoEditEntryBlock = isVideoEditMode ? (
		<VideoEditEntryBlock
			intentsCount={videoEditIntents.length}
			{...(videoEditDisabledReason ? { disabledReason: videoEditDisabledReason } : {})}
			{...(onOpenVideoEdit ? { onOpenVideoEdit: () => onOpenVideoEdit() } : {})}
			{...(onOpenVideoFrameCapture ? { onOpenVideoFrameCapture: () => onOpenVideoFrameCapture() } : {})}
		/>
	) : null;

	const header = (
		<PanelHeader
			{...(referencesSlot !== undefined ? { referencesSlot } : {})}
			{...(data.taskStatus !== undefined ? { taskStatus: data.taskStatus } : {})}
			{...(data.errorMessage !== undefined ? { errorMessage: data.errorMessage } : {})}
			showExpand={showExpand && !isAudioTask}
			expanded={expanded}
			onExpand={() => onExpand?.()}
			onCollapse={() => onCollapse?.()}
			{...(onClose ? { onClose } : {})}
		/>
	);

	const promptBlock = (
		<PromptBox
			videoEditIntents={videoEditIntents}
			{...(videoEditDisabledReason ? { videoEditDisabledReason } : {})}
			{...(videoEditEntryBlockedReason ? { videoEditEntryBlockedReason } : {})}
			{...(onOpenVideoEdit ? { onOpenVideoEdit: (intentId?: string) => onOpenVideoEdit(intentId) } : {})}
			{...(onOpenVideoEditIntent ? { onOpenVideoEditIntent } : {})}
			{...(onRemoveVideoEditIntent ? { onRemoveVideoEditIntent } : {})}
			{...(promptEditorSlot ? { promptEditorSlot } : {})}
			prompt={prompt}
			onPromptChange={(next) => {
				setPrompt(next);
				patch({ panelPrompt: next });
			}}
			onKeyDown={handleKeyDown}
			onSubmit={submit}
			skillError={skillError}
		/>
	);

	const showParameterSheet = showModelSelector || fields.length > 0;
	const showRunActions = showRun || showPolish;

	const parameterSheet = (
		<div className="mc-panel__parameters">
			{modelSelectorSlot ?? (showModelSelector ? (
				<div className="mc-panel__model">
					<ModelSelector
						model={model}
						options={config.modelOptions}
						open={modelOpen}
						onOpenChange={setModelOpen}
						onChange={(nextModel) =>
							patch({
								parameters: parametersAfterModelSwitch(config, parameters, nextModel),
							})
						}
					/>
				</div>
			) : null)}
			{true ? (
				<SettingsMenu
					fields={fields}
					parameters={effectiveParameters}
					open={settingsOpen}
					onOpenChange={setSettingsOpen}
					onChange={patchParameters}
				/>
			) : null}
		</div>
	);

	const runBlock = (
		<RunActions
			showPolish={showPolish}
			polishOpen={polishOpen}
			onTogglePolish={() => setPolishOpen((open) => !open)}
			activeSkill={activeSkill}
			polishProcessing={polishProcessing}
			visibleSkills={visibleSkills}
			onRunSkill={runSkill}
			showRun={showRun}
			busy={busy}
			canRun={canRun}
			{...(disabledHint ? { disabledHint } : {})}
			hasBlockingReasons={hasBlockingReasons}
			pendingLabel={busyLabel}
			runLabel={actionLabel}
			onSubmit={submit}
		/>
	);

	// 紧凑面由节点/活动栈与主按钮承载阶段；展开面遮住画布，必须就近保留任务反馈。
	const statusRow =
		status === "failed" && !expanded ? (
			<div className="mc-panel__status-row">
				<span className="mc-panel__status" data-status={status}>
					{STATUS_LABEL[status]}
				</span>
			</div>
		) : null;

	const inlineStatus = statusSlot ? (
		<div className="mc-panel__inline-status" role="status" aria-live="polite">
			{statusSlot}
		</div>
	) : null;

	// 提交前的可理解提示：参数越界（枚举/范围）与宿主阻止原因并排展示，避免只藏在主操作 tooltip 里。
	const visibleBlockingReasons = [...parameterViolations, ...(blockingReasons ?? [])];
	const blockingBlock = <BlockingBlock reasons={visibleBlockingReasons} />;
	// Agent 详情具名入口：与阶段/错误/结果摘要同排，位于状态区、临近主操作（design D6）。
	const agentDetailBlock = <AgentDetailBlock action={agentDetailAction} {...(onViewAgentDetail ? { onView: onViewAgentDetail } : {})} />;
	const runActionGroup = showRunActions ? (
		<div className="mc-panel__run-action-group">
			{agentDetailBlock}
			<div className="mc-panel__grid-item mc-panel__grid-item--untitled mc-panel__grid-run">
				<span className="mc-panel__grid-control">{runBlock}</span>
			</div>
		</div>
	) : agentDetailBlock;
	const runGridItem = showRunActions ? (
		<div className="mc-panel__grid-item mc-panel__grid-item--untitled mc-panel__grid-run">
			<span className="mc-panel__grid-control">
				<div className="mc-panel__inline-run-actions">{agentDetailBlock}{runBlock}</div>
			</span>
		</div>
	) : agentDetailBlock;
	const executionFeedback = expanded ? (
		<ExecutionStatus
			status={status}
			taskLabel={TASK_LABEL[taskKind]}
			readOnly={readOnly}
			{...(data.progress !== undefined ? { progress: data.progress } : {})}
			{...(onViewTask ? { onViewTask } : {})}
		/>
	) : null;

	const audioLayout = (
		<div className="mc-panel__audio-layout">
			{statusRow ? <div className="mc-panel__audio-status">{statusRow}</div> : null}
			<div className="mc-panel__grid mc-panel__audio-header">{header}{inlineStatus}</div>
			<div className="mc-panel__grid mc-panel__audio-prompt">
				<div className="mc-panel__grid-item mc-panel__grid-item--untitled mc-panel__grid-prompt">
					<span className="mc-panel__grid-control">{promptBlock}</span>
				</div>
			</div>
			<div className="mc-panel__audio-footer">
				<div className="mc-panel__audio-footer-left">
					<div className="mc-panel__grid-item mc-panel__grid-item--untitled mc-panel__grid-parameter">
						<span className="mc-panel__grid-control">{parameterSheet}</span>
					</div>
				</div>
				<div className="mc-panel__audio-footer-right">
					<div className="mc-panel__run-action-group">
						{agentDetailBlock}
						<div className="mc-panel__grid-item mc-panel__grid-item--untitled mc-panel__grid-run">
							<span className="mc-panel__grid-control">{runBlock}</span>
						</div>
					</div>
				</div>
			</div>
			{blockingBlock}
		</div>
	);

	const editor = (
		<div
			className={`mc-panel${expanded ? " mc-panel--expanded" : ""}${
				isAudioTask && !expanded ? " mc-panel--audio" : ""
			}${
				taskKind === "video-generation" ? " mc-panel--video-edit" : ""
			}${className ? ` ${className}` : ""}`}
			data-surface={surface}
			data-task-kind={taskKind}
			role="region"
			aria-label="节点提示词编辑"
			style={width ? ({ width } as CSSProperties) : undefined}
		>
			{expanded && showFormatToolbar ? (
				<FormatToolbar onCommand={onFormatCommand} />
			) : null}
			{isAudioTask && !expanded ? (
				audioLayout
			) : usesSectioned ? (
				<div className="mc-panel__sectioned-layout">
					{statusRow ? <div className="mc-panel__audio-status">{statusRow}</div> : null}
					<div className="mc-panel__grid mc-panel__sectioned-header">{header}{inlineStatus}</div>
					<div className="mc-panel__grid mc-panel__sectioned-prompt">
						<div className="mc-panel__grid-item mc-panel__grid-item--untitled mc-panel__grid-prompt">
							<span className="mc-panel__grid-control">{promptBlock}</span>
						</div>
					</div>
					<div className="mc-panel__grid mc-panel__sectioned-footer">
						{executionFeedback}
						{showParameterSheet ? (
							<div className="mc-panel__grid-item mc-panel__grid-item--untitled mc-panel__grid-parameter">
								<span className="mc-panel__grid-control">{parameterSheet}</span>
							</div>
						) : null}
						{runActionGroup}
						{blockingBlock}
						{videoEditEntryBlock}
					</div>
				</div>
			) : (
				<div className="mc-panel__grid">
					{statusRow ? (
						<div className="mc-panel__grid-item mc-panel__grid-item--untitled" style={{ gridColumn: "span 24" }}>
							<span className="mc-panel__grid-control">{statusRow}</span>
						</div>
					) : null}
					{header}
					{inlineStatus}
					<div className="mc-panel__grid-item mc-panel__grid-item--untitled mc-panel__grid-prompt">
						<span className="mc-panel__grid-control">{promptBlock}</span>
					</div>
					{showParameterSheet ? (
						<div className="mc-panel__grid-item mc-panel__grid-item--untitled mc-panel__grid-parameter">
							<span className="mc-panel__grid-control">{parameterSheet}</span>
						</div>
					) : null}
					{runGridItem}
					{blockingBlock}
					{videoEditEntryBlock}
				</div>
			)}
		</div>
	);

	// expanded 的 fullscreen 宿主由 Canvas Shell / 宿主（`FullscreenPanelHost`）提供，
	// 组件本身不再自绘 overlay（design D5）。
	return (
		<div className="mc-panel__host" data-surface={expanded ? "canvas" : surface}>
			{editor}
		</div>
	);
}

export type { ExecutionPanelTaskKind };
