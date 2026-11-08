/**
 * 执行面板的可复用视图块
 * （change: 2026-09-28-split-frontend-god-plugins，task 6；从 ExecutionPanel.tsx 拆出）。
 *
 * 只做展示与回调转发；状态与提交语义仍由 `ExecutionPanel` 持有。拆分不改变 DOM 结构。
 */
import {
	CloseIcon,
	CollapseIcon,
	ExpandIcon,
	LoadingIcon,
	Popover,
	WandSparklesIcon
} from "@woohaa3/ui";
import { SendPlaneIcon } from "./icons.js";
import { ErrorInspector } from "./error-inspector.js";
import { formatVideoTime } from "./panel-shared.js";
import { promptSubmitHint } from "../prompt-keyboard.js";
import type { ExecutionPanelData, ExecutionPanelSkill, ExecutionPanelStatus } from "./types.js";
import type { AgentDetailAction } from "./agent-detail-action.js";

const PLACEHOLDER =
	"描述任何你想要生成的内容，按 @ 引用身份资产；Enter 生成，Shift+Enter 换行";

const BLOCKING_REASONS_ID = "mc-panel-blocking-reasons";

/** 头部：参考区 + 错误详情 + 展开/收起/关闭动作。 */
export function PanelHeader({
	referencesSlot,
	taskStatus,
	errorMessage,
	showExpand,
	expanded,
	onExpand,
	onCollapse,
	onClose,
}: {
	referencesSlot?: React.ReactNode;
	taskStatus?: ExecutionPanelData["taskStatus"];
	errorMessage?: string;
	showExpand: boolean;
	expanded: boolean;
	onExpand: () => void;
	onCollapse: () => void;
	onClose?: () => void;
}) {
	return (
		<>
			<div className="mc-panel__grid-item mc-panel__grid-item--untitled mc-panel__grid-references">
				<span className="mc-panel__grid-control">
					{referencesSlot ?? <span className="mc-panel__reference-hint" />}
				</span>
			</div>
			<div
				className="mc-panel__grid-item mc-panel__grid-item--untitled mc-panel__grid-tool mc-panel__grid-header-actions"
				style={{ gridColumn: "-5 / -1" }}
			>
				<span className="mc-panel__grid-control">
					<div className="mc-panel__header-actions">
						{taskStatus === "failed" && errorMessage ? (
							<ErrorInspector error={errorMessage} />
						) : null}
						{showExpand ? (
							<button
								type="button"
								className="mc-panel__expand"
								data-tooltip={expanded ? "退出大编辑" : "展开编辑"}
								aria-label={expanded ? "退出大编辑" : "展开提示词编辑器"}
								aria-expanded={expanded}
								onClick={expanded ? onCollapse : onExpand}
							>
								{expanded ? (
									<CollapseIcon className="mc-panel__icon" />
								) : (
									<ExpandIcon className="mc-panel__icon" />
								)}
							</button>
						) : null}
						{onClose ? (
							<button
								type="button"
								className="mc-panel__close"
								data-tooltip="关闭"
								aria-label="关闭执行面板"
								onClick={onClose}
							>
								<CloseIcon className="mc-panel__icon" />
							</button>
						) : null}
					</div>
				</span>
			</div>
		</>
	);
}

/** 视频编辑入口（`edit_video` 模式）：编辑标注 + 截帧。 */
export function VideoEditEntryBlock({
	intentsCount,
	disabledReason,
	onOpenVideoEdit,
	onOpenVideoFrameCapture,
}: {
	intentsCount: number;
	disabledReason?: string;
	onOpenVideoEdit?: () => void;
	onOpenVideoFrameCapture?: () => void;
}) {
	return (
		<div className="mc-panel__video-edit-entry">
			<button
				type="button"
				className="mc-panel__video-edit-open"
				disabled={Boolean(disabledReason)}
				title={disabledReason ?? "打开视频编辑"}
				onClick={() => onOpenVideoEdit?.()}
			>
				{intentsCount > 0 ? `编辑标注（${intentsCount}）` : "编辑视频标注"}
			</button>
			<button
				type="button"
				className="mc-panel__video-edit-open"
				disabled={Boolean(disabledReason)}
				title={disabledReason ?? "视频截帧"}
				onClick={() => onOpenVideoFrameCapture?.()}
			>
				视频截帧
			</button>
			{disabledReason ? (
				<span className="mc-panel__video-edit-reason" role="status">
					{disabledReason}
				</span>
			) : null}
		</div>
	);
}

/** 提示词输入区：视频编辑标签 + 结构化 prompt editor / textarea。 */
export function PromptBox({
	videoEditIntents,
	videoEditDisabledReason,
	videoEditEntryBlockedReason,
	onOpenVideoEdit,
	onOpenVideoEditIntent,
	onRemoveVideoEditIntent,
	promptEditorSlot,
	prompt,
	onPromptChange,
	onKeyDown,
	onSubmit,
	skillError,
}: {
	videoEditIntents: NonNullable<ExecutionPanelData["videoEditIntents"]>;
	videoEditDisabledReason?: string;
	videoEditEntryBlockedReason?: string;
	onOpenVideoEdit?: (intentId?: string) => void;
	onOpenVideoEditIntent?: (id: string) => void;
	onRemoveVideoEditIntent?: (id: string) => void;
	promptEditorSlot?: (args: {
		value: string;
		onChange: (next: string) => void;
		disabled: boolean;
		placeholder: string;
		onSubmit?: () => void;
	}) => React.ReactNode;
	prompt: string;
	onPromptChange: (next: string) => void;
	onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
	onSubmit?: () => void;
	skillError: string | null;
}) {	return (
		<>
			<div className="mc-panel__prompt-box">
				{videoEditIntents.length > 0 ? (
					<div className="mc-panel__video-edit-tags" aria-label="视频编辑意图">
						{videoEditIntents.map((intent) => (
							<span key={intent.id} className="mc-panel__video-edit-tag">
								<button
									type="button"
									title={
										videoEditDisabledReason ??
										videoEditEntryBlockedReason ??
										(onOpenVideoEdit || onOpenVideoEditIntent ? "打开编辑点" : "尚未装配视频编辑")
									}
									data-testid="video-edit-intent"
									data-intent-id={intent.id}
									disabled={
										Boolean(videoEditDisabledReason) ||
										Boolean(videoEditEntryBlockedReason) ||
										(!onOpenVideoEdit && !onOpenVideoEditIntent)
									}
									onClick={() => (onOpenVideoEdit ?? onOpenVideoEditIntent)?.(intent.id)}
								>
									{intent.annotationPreviewUrl ?? intent.annotationImageDataUrl ? (
										<img
											src={intent.annotationPreviewUrl ?? intent.annotationImageDataUrl}
											alt=""
											className="mc-panel__video-edit-tag-image"
										/>
									) : null}
									<strong>
										{formatVideoTime(intent.startSeconds)}
										{intent.endSeconds !== undefined
											? `-${formatVideoTime(intent.endSeconds)}`
											: ""}
									</strong>
									<span>{intent.prompt}</span>
								</button>
								<button
									type="button"
									className="mc-panel__video-edit-tag-remove"
									aria-label="删除视频编辑意图"
									onClick={() => onRemoveVideoEditIntent?.(intent.id)}
								>
									<CloseIcon className="mc-panel__icon" />
								</button>
							</span>
						))}
					</div>
				) : null}
				{promptEditorSlot ? (
					// 宿主提供的结构化 prompt editor（change: add-reference-inputs-and-mentions，任务 4.4）：
					// 使用与 textarea 相同的 value/change/submit 契约，ExecutionPanel 不感知其内部实现。
					promptEditorSlot({
						value: prompt,
						onChange: onPromptChange,
						disabled: false,
						placeholder: PLACEHOLDER,
						onSubmit,
					})
				) : (
					<textarea
						className="mc-panel__textarea nowheel"
						placeholder={PLACEHOLDER}
						value={prompt}
						onChange={(event) => onPromptChange(event.target.value)}
						onKeyDown={onKeyDown}
						rows={4}
					/>
				)}
			</div>
			{skillError ? <p className="mc-panel__error">{skillError}</p> : null}
		</>
	);
}

/** 快捷改写菜单 + 主操作按钮。 */
export function RunActions({
	showPolish,
	polishOpen,
	onTogglePolish,
	activeSkill,	polishProcessing,
	visibleSkills,
	onRunSkill,
	showRun,
	busy,
	canRun,
	hasBlockingReasons,
	disabledHint,
	pendingLabel,
	runLabel,
	onSubmit,
}: {
	showPolish: boolean;
	polishOpen: boolean;
	onTogglePolish: () => void;
	activeSkill: string | null;
	polishProcessing: boolean;
	visibleSkills: ReadonlyArray<ExecutionPanelSkill>;
	onRunSkill: (skill: ExecutionPanelSkill) => void;
	showRun: boolean;
	busy: boolean;
	canRun: boolean;
	hasBlockingReasons: boolean;
	/** 按钮不可点时的原因，显示在 tooltip 上。 */
	disabledHint?: string;
	pendingLabel: string;
	runLabel?: string;
	onSubmit: () => void;
}) {
	return (
		<div className="mc-panel__run-actions">
			{showPolish ? (
				<div
					className="mc-panel__polish-menu-wrap"
				>
					<Popover
						open={polishOpen}
						onOpenChange={(next) => {
							if (next !== polishOpen) onTogglePolish();
						}}
						side="top"
						align="start"
						className="mc-panel__polish-menu"
						dismissOnOutside
						trigger={
							<button
								type="button"
								className={`mc-panel__icon-btn mc-panel__universal-polish${polishProcessing ? " is-processing" : ""}`}
								data-tooltip={polishProcessing ? "改写中…" : "快捷改写"}
								aria-label={polishProcessing ? "快捷改写处理中" : "打开快捷改写"}
								aria-haspopup="dialog"
								aria-expanded={polishOpen}
								disabled={activeSkill !== null}
							>
								{polishProcessing ? (
									<LoadingIcon className="mc-panel__universal-polish-spinner" />
								) : (
									<WandSparklesIcon className="mc-panel__universal-polish-icon" />
								)}
							</button>
						}
					>
						<div className="mc-panel__skill-section-heading">
							<span className="mc-panel__skill-section-title">快捷改写</span>
						</div>
						<button
							type="button"
							className="mc-panel__skill-item"
							onClick={() => onRunSkill({ id: "universal-polish", label: "通用润色", description: "优化表达并补充关键细节" })}
						>
							<span className="mc-panel__skill-item-copy">
								<strong>通用润色</strong>
								<small>优化表达并补充关键细节</small>
							</span>
						</button>
						{visibleSkills.map((skill) => (
							<button
								key={skill.id}
								type="button"
								className="mc-panel__skill-item"
								aria-label={`${skill.label}：${skill.description}`}
								onClick={() => onRunSkill(skill)}
							>
								<span className="mc-panel__skill-item-copy">
									<strong>{skill.label}</strong>
									<small>{skill.description}</small>
								</span>
							</button>
						))}
					</Popover>
				</div>
			) : null}
			{showRun ? (
				<button
					type="button"
					className={`mc-panel__send${busy ? " is-processing" : ""}`}
					data-execution-launch=""
						data-tooltip={busy ? pendingLabel : !canRun && disabledHint ? disabledHint : `${runLabel ?? "执行生成"} · ${promptSubmitHint()}`}
						title={busy ? pendingLabel : !canRun && disabledHint ? disabledHint : promptSubmitHint()}
					aria-label={busy ? pendingLabel : (runLabel ?? "执行生成")}
					aria-busy={busy || undefined}
					aria-describedby={hasBlockingReasons ? BLOCKING_REASONS_ID : undefined}
					disabled={!canRun || busy}
					onClick={onSubmit}
				>
					{busy ? <LoadingIcon className="mc-panel__send-icon mc-panel__send-spinner" /> : <SendPlaneIcon className="mc-panel__send-icon" />}
					<span className="mc-panel__send-label">{busy ? pendingLabel : (runLabel ?? "执行生成")}</span>
				</button>
			) : null}
			{showRun ? (
				<span className="mc-panel__shortcut-hint" data-testid="prompt-submit-hint">
					{promptSubmitHint()}
				</span>
			) : null}
		</div>
	);
}

/** 展开工作区的任务反馈，只读取宿主提供的权威阶段与百分比。 */
export function ExecutionStatus({ status, taskLabel, progress, readOnly, onViewTask }: {
	status: ExecutionPanelStatus;
	taskLabel: string;
	progress?: number;
	readOnly: boolean;
	onViewTask?: () => void;
}) {
	if (status === "idle" && !readOnly) return null;
	const percentage = typeof progress === "number" && Number.isFinite(progress)
		? Math.round(Math.min(100, Math.max(0, progress))) : null;
	const label = readOnly ? "当前画布只读，无法生成"
		: status === "pending" ? "任务排队中"
		: status === "processing" ? `${taskLabel}生成中${percentage !== null ? ` · ${percentage}%` : ""}`
		: status === "materializing" ? `${taskLabel}媒体准备中${percentage !== null ? ` · ${percentage}%` : ""}`
		: status === "successed" ? `${taskLabel}生成已完成`
		: "生成失败，请查看错误详情";
	return (
		<div className="mc-panel__execution-feedback" data-status={status}>
			<span role="status" aria-live="polite" aria-atomic="true">
				{label}
			</span>
			{status !== "idle" && onViewTask ? (
				<button type="button" className="mc-panel__view-task" onClick={onViewTask}>查看任务</button>
			) : null}
		</div>
	);
}

/**
 * Agent 对话详情的具名状态入口
 * （change: 2026-10-12-add-agent-conversation-panel，任务 5.2 / design D6）。
 *
 * 只渲染宿主派生的权威摘要与具名动作；显著程度由 `emphasis` 决定（颜色仅辅助）。点击**只**
 * 调用 `onView` 打开详情/定位回合，绝不触发生成、重试或取消。无 `action` 时不渲染
 * （首次无会话不制造空记录）。
 */
export function AgentDetailBlock({ action, onView }: {
	action: AgentDetailAction | null | undefined;
	onView?: () => void;
}) {
	if (!action) return null;
	return (
		<div
			className={`mc-panel__agent-detail is-${action.emphasis}`}
			data-emphasis={action.emphasis}
		>
			<span className="mc-panel__agent-detail-summary">{action.summary}</span>
			<button
				type="button"
				className="mc-panel__agent-detail-action"
				data-testid="agent-detail-action"
				onClick={() => onView?.()}
			>
				{action.label}
			</button>
		</div>
	);
}

/** 阻止原因（可被辅助技术读取；主操作用 aria-describedby 指向它）。 */
export function BlockingBlock({ reasons }: { reasons?: ReadonlyArray<string> }) {
	if (!reasons || reasons.length === 0) return null;
	return (
		<div
			className="mc-panel__grid-item mc-panel__grid-item--untitled mc-panel__grid-errors"
			style={{ gridColumn: "span 24" }}
		>
			<span className="mc-panel__grid-control">
				<div className="mc-panel__errors" id={BLOCKING_REASONS_ID} role="status">
					{reasons.map((reason, index) => (
						<p key={`${index}-${reason}`} className="mc-panel__error">
							{reason}
						</p>
					))}
				</div>
			</span>
		</div>
	);
}
