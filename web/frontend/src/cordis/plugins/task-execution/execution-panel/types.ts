/**
 * 执行面板的对外契约。
 *
 * 任务面板规格与参数字段，不依赖画布运行时，
 * 使其可独立渲染（组件库查看页、后续接入画布运行时均可复用）。
 */
import type { PptaskParameterControl } from "@woohaa3/contracts";
import type { ExecutionPanelPresentation } from "../../../navigation/contracts.js";

/** 生成任务类型。 */
export type ExecutionPanelTaskKind =
	| "text-generation"
	| "image-generation"
	| "video-generation"
	| "audio-generation";

/** 面板所在的面（对齐原工程 editor surface）。 */
export type ExecutionPanelSurface = "canvas" | "sidebar" | "dock";

/** 任务执行状态。 */
export type ExecutionPanelStatus =
	| "idle"
	| "pending"
	| "processing"
	/** provider 已产出、正在转存稳定媒体（change: 2026-11-06-fix-media-output-readiness）。 */
	| "materializing"
	| "successed"
	| "failed";

/** 单个生成参数。 */
export interface ExecutionPanelParameterField {
	key: string;
	label: string;
	type?: "select" | "number" | "text" | "boolean" | "textarea";
	/** `slider` 时用 range 呈现（配合 minimum/maximum/step）。 */
	control?: "slider";
	options?: ReadonlyArray<{ value: string; label: string }>;
	defaultValue?: string | number | boolean;
	/**
	 * Provider schema 标记为必填（`inputSchema.required`）。
	 *
	 * 缺省 false。必填字段在提交前必须已经解析出值（默认值也算），否则面板就地报可读错误，
	 * 不把请求发给 Provider 再等它回一句英文错误（A9）。
	 */
	required?: boolean;
	minimum?: number;
	maximum?: number;
	step?: number;
	unit?: string;
	/**
	 * Provider 声明的控件语义（`x-pptask-control`）。
	 *
	 * 面板据此选控件：`aspect-ratio` → 比例瓦片，`resolution` → 等宽分段，`quality` → 普通分段。
	 * 缺省时沿用旧的结构启发式（枚举全为比例才当比例字段），不按 key 名猜测。
	 */
	semantic?: PptaskParameterControl;
	/**
	 * 「自适应」选项的取值（`x-pptask-adaptive`）。
	 *
	 * 只有标记过才存在；比例控件优先用它识别自适应项，未标记时按 `auto`/`adaptive` 兜底。
	 */
	adaptiveValue?: string;
	/** 命中任一规则时隐藏该字段。 */
	hiddenWhen?: ReadonlyArray<{
		field: string;
		equals: string | number | boolean;
	}>;
	/**
	 * 每个选项的联动约束（`x-pptask-requires`）：选中它就要把别的字段改成某值。
	 *
	 * 典型是「透明背景要求 PNG 输出」。面板选中该选项时**先改写目标字段再落值**，
	 * 并把目标字段显示为锁定态——让用户看见「因为选了透明，格式被固定成 PNG」，
	 * 而不是提交后收到上游 400。
	 */
	requiresByValue?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/** 模型选项与参数模式。 */
export interface ExecutionPanelModelConfig {
	modelOptions: ReadonlyArray<{ value: string; label: string; detail?: string; provider?: string }>;
	defaultModel: string;
	parameterSchemaByModel?: Record<
		string,
		ReadonlyArray<ExecutionPanelParameterField>
	>;
	defaultsByModel?: Record<string, Record<string, unknown>>;
}

/** 格式工具栏命令（对齐源工程 PromptFormatCommand）。 */
export type ExecutionPanelFormatCommand =
	| { type: "block"; value: "h1" | "h2" | "h3" | "paragraph" }
	| { type: "text"; value: "bold" | "italic" | "underline" }
	| { type: "style"; property: "color" | "background-color"; value: string }
	| { type: "clear" };

/** 视频编辑意图（video-generation + edit_video 时提示词上方的标签）。 */
export interface ExecutionPanelVideoEditIntent {
	id: string;
	startSeconds: number;
	endSeconds?: number;
	prompt: string;
	/** 稳定标记图同源 URL（仅展示，来自已确认的稳定 preview identity）。 */
	annotationPreviewUrl?: string;
	/**
	 * 标记图数据 URL 兜底（change: expand-showcase-execution-ux 查看页 fixture 使用）。
	 * 与 `annotationPreviewUrl` 二选一；两者都提供时优先同源 URL。
	 */
	annotationImageDataUrl?: string;
	/** 标注数量（可选的稳定摘要，用于 chip 展示）。 */
	annotationCount?: number;
}

/** 节点数据（面板读写的最小集合）。 */
export interface ExecutionPanelData {
	title?: string;
	panelPrompt?: string;
	taskStatus?: ExecutionPanelStatus;
	progress?: number;
	errorMessage?: string;
	parameters?: Record<string, unknown>;
	/** video-edit 标签；仅 video-generation + parameters.generationMode === "edit_video" 时展示。 */
	videoEditIntents?: ReadonlyArray<ExecutionPanelVideoEditIntent>;
}

/** 快捷改写技能。 */
export interface ExecutionPanelSkill {
	id: string;
	label: string;
	description: string;
}

/**
 * 主操作提交时回调的**完整输入快照**。
 *
 * 面板是纯 UI，不持有任务状态；宿主据此把「用户当下看到并确认的输入」提交给任务网关。
 * `prompt` 取自面板本地状态（不经过父组件回流），因此即使父组件尚未重渲染，
 * 提交的也是用户当前输入的内容。
 */
export interface ExecutionPanelRunSnapshot {
	/** 用户当前输入的提示词（原样，不 trim）。 */
	prompt: string;
	/** 本次提交的模型 id（已解析过默认值）。 */
	model: string;
	/** 本次提交的完整参数（一定包含 `model` 键）。 */
	parameters: Record<string, unknown>;
}

export interface ExecutionPanelProps {
	/** 任务类型；决定可用技能与默认文案。 */
	taskKind: ExecutionPanelTaskKind;
	/** 模型与参数配置。 */
	modelConfig: ExecutionPanelModelConfig;
	/** 受控数据。 */
	data?: ExecutionPanelData;
	/** 所在面，默认 `canvas`（节点内联编辑器）。 */
	surface?: ExecutionPanelSurface;
	/** 主操作文案；缺省按任务类型显示「生成图片」等。 */
	runLabel?: string;
	/** 主操作进行中文案，默认「生成中」。 */
	pendingLabel?: string;
	/** 查看当前节点的任务；由宿主提供导航能力。 */
	onViewTask?: () => void;
	/**
	 * Agent 对话详情的按状态入口（change: 2026-10-12-add-agent-conversation-panel，任务 5.2）。
	 *
	 * 由宿主根据权威回合状态派生（见 `agent-detail-action.ts`）；缺省不渲染。点击只打开详情，
	 * 不触发重试/生成/取消。首次无会话时传 `null`，不制造空记录。
	 */
	agentDetailAction?: import("./agent-detail-action.js").AgentDetailAction | null;
	/** 点击 Agent 详情入口；由宿主切换到详情 route（只读打开）。 */
	onViewAgentDetail?: () => void;
	/** 是否展示展开按钮。 */
	showExpand?: boolean;
	/**
	 * 是否展示面板内联的生成模型选择器；默认 `true`。
	 *
	 * Dock 面若由宿主提供独立的模型导航（`ExecutionPanelModelNav`），应关掉内联选择器，
	 * 避免与宿主重复（change: align-showcase-reference-ux，任务 2.2）。
	 */
	showModelSelector?: boolean;
	/** 是否展示面板内联主操作（发送/执行）；默认 `true`。宿主把执行放到自有 action 区时关掉。 */
	showRun?: boolean;
	/** 是否展示快捷改写入口。 */
	showPolish?: boolean;
	/** 展开态是否展示富文本格式工具栏。 */
	showFormatToolbar?: boolean;
	/** 格式工具栏命令（展开态）。宿主可接到富文本编辑器；不传则为展示态。 */
	onFormatCommand?: (command: ExecutionPanelFormatCommand) => void;
	/**
	 * 受控 presentation（change: 2026-09-28-align-execution-reference-and-expansion，design D5）。
	 *
	 * `compact` 为常规底部面板，`expanded` 为大编辑态。组件不再持有本地 expanded 权威状态；
	 * expanded 的 fullscreen 宿主由调用方提供。
	 */
	presentation?: ExecutionPanelPresentation;
	/** 面板宽度（canvas 面无固有宽度，查看页用它模拟节点盒）。 */
	width?: number;
	/** 可用快捷改写技能；不传则用内置默认。 */
	skills?: ReadonlyArray<ExecutionPanelSkill>;
	/**
	 * 快捷改写被选中时的回调（change: expand-showcase-execution-ux）。
	 *
	 * 生产站点由提示词工具插件承载改写；未装配工具插件时缺省显示「未接入」提示。
	 * 提供本回调后，面板把「所选 action + 当前草稿」交给宿主，不再显示缺省提示。
	 *
	 * 返回 Promise 时面板保持「改写中」直到 settle：成功关闭菜单，失败显示就地错误。
	 */
	onPromptSkill?: (input: { id: string; label: string; prompt: string }) => void | Promise<void>;
	/** 顶部参考区插槽（画布参考素材 chips）。 */
	referencesSlot?: React.ReactNode;
	/**
	 * 内联状态槽：渲染在面板头部与提示词之间，由宿主持有运行状态（生成阶段/时长/取消）。
	 * 与内部 `taskStatus` 失败 chip 相互独立；提供时原样插入面板网格/分区布局。
	 */
	statusSlot?: React.ReactNode;
	/**
	 * 结构化 prompt editor 插槽（change: add-reference-inputs-and-mentions，任务 4.4）。
	 * 提供时替换缺省 textarea；契约与 textarea 相同（value/onChange/disabled/placeholder），
	 * 并接收面板的 `onSubmit` 以保持 Enter 生成、Shift+Enter 换行。
	 */
	promptEditorSlot?: (args: {
		value: string;
		onChange: (next: string) => void;
		disabled: boolean;
		placeholder: string;
		onSubmit?: () => void;
	}) => React.ReactNode;
	/** 删除视频编辑意图。 */
	onRemoveVideoEditIntent?: (id: string) => void;
	/**
	 * 重开视频编辑 dialog（change: port-video-editing-dialogs，任务 4.2）。
	 * `intentId` 提供时预选该编辑点，否则打开完整草稿。
	 */
	onOpenVideoEdit?: (intentId?: string) => void;
	/** 从 `edit_video` 面板打开视频截帧 dialog（任务 2.1）。 */
	onOpenVideoFrameCapture?: () => void;
	/**
	 * edit_video 编辑入口不可用的原因（缺视频/失效/只读/pending）。
	 * 非空时「编辑」入口禁用并展示该原因（design D9）。
	 */
	videoEditDisabledReason?: string;
	/**
	 * 打开视频编辑入口（`edit_video` 模式的「打开编辑点」动作）。
	 *
	 * 传入回调才启用；`videoEditEntryBlockedReason` 非空时入口禁用并显示该原因
	 * （例如缺少 ready 的输入视频）。完整视频编辑 dialog 由 `canvas-video-workflow` 提供。
	 */
	onOpenVideoEditIntent?: (id: string) => void;
	/** `edit_video` 入口被阻止的原因；非空时入口禁用并作为 title 解释。 */
	videoEditEntryBlockedReason?: string;
	/**
	 * 阻止执行的原因（对齐源工程 identityBlockingReasons）。
	 * 非空时在主操作上方以网格整行展示，用 `role="status"` 宣告，并**真正禁用**主操作。
	 */
	blockingReasons?: ReadonlyArray<string>;
	/**
	 * 会话级只读（断线只读等）。
	 *
	 * 只读状态属于会话，不通过 `blockingReasons` 在面板里重复枚举（由左下角同步状态控件
	 * 的常驻 tooltip 承载）；但仍必须**真正禁用**主操作与回车提交。
	 */
	readOnly?: boolean;
	/**
	 * 提示词为空时仍允许回车提交。图片节点用它改走上游文字节点的内容。
	 */
	allowEmptySubmit?: boolean;
	/** 任意字段变更。 */
	onChange?: (patch: Partial<ExecutionPanelData>) => void;
	/**
	 * 主操作（执行生成）。回调本次提交的完整快照（prompt / model / parameters）。
	 *
	 * **BREAKING**（仓库内部）：由 `() => void` 改为携带快照 —— 宿主要求提交"用户当下看到的输入"，
	 * 而不是自己去 guess 面板内部状态。
	 */
	onRun?: (snapshot: ExecutionPanelRunSnapshot) => void;
	/** 展开为大编辑（受控；提交 expand intent）。 */
	onExpand?: () => void;
	/** 收起回 compact（受控；提交 collapse intent）。 */
	onCollapse?: () => void;
	/** 关闭面板（受控；提交匹配 identity 的 close intent）。 */
	onClose?: () => void;
	className?: string;
}

/** 图片任务默认参数配置（查看页 fixture 用）。 */
export const IMAGE_MODEL_CONFIG: ExecutionPanelModelConfig = {
	modelOptions: [
		{ value: "seedream-5-pro", label: "即梦 5.0 Pro" },
		{ value: "gemini-3.1-flash-image", label: "Gemini 3.1 Flash Image" },
	],
	defaultModel: "seedream-5-pro",
	parameterSchemaByModel: {
		"seedream-5-pro": [
			{
				key: "ratio",
				label: "画幅比例",
				type: "select",
				options: [
					{ value: "1:1", label: "1:1" },
					{ value: "9:16", label: "9:16" },
					{ value: "16:9", label: "16:9" },
				],
				defaultValue: "1:1",
			},
			{
				key: "resolution",
				label: "分辨率",
				type: "select",
				options: [
					{ value: "1K", label: "1K" },
					{ value: "2K", label: "2K" },
				],
				defaultValue: "1K",
			},
		],
		"gemini-3.1-flash-image": [
			{
				key: "ratio",
				label: "画幅比例",
				type: "select",
				options: [
					{ value: "1:1", label: "1:1" },
					{ value: "9:16", label: "9:16" },
				],
				defaultValue: "1:1",
			},
		],
	},
	defaultsByModel: {
		"seedream-5-pro": { ratio: "1:1", resolution: "1K" },
		"gemini-3.1-flash-image": { ratio: "1:1" },
	},
};

/** 文本任务默认参数配置。 */
export const TEXT_MODEL_CONFIG: ExecutionPanelModelConfig = {
	modelOptions: [
		{ value: "doubao-seed-2-1-pro-260628", label: "Seed 2.1 Pro" },
		{ value: "gemini-3-pro", label: "Gemini 3 Pro" },
	],
	defaultModel: "doubao-seed-2-1-pro-260628",
	parameterSchemaByModel: {
		"doubao-seed-2-1-pro-260628": [],
		"gemini-3-pro": [],
	},
	defaultsByModel: {
		"doubao-seed-2-1-pro-260628": {},
		"gemini-3-pro": {},
	},
};

/** 视频任务默认参数配置。 */
export const VIDEO_MODEL_CONFIG: ExecutionPanelModelConfig = {
	modelOptions: [
		{ value: "seedance2_5", label: "Seedance 2.5" },
		{ value: "seedance2_0", label: "Seedance 2.0" },
	],
	defaultModel: "seedance2_5",
	parameterSchemaByModel: {
		seedance2_5: [
			{
				key: "ratio",
				label: "画幅比例",
				type: "select",
				options: [
					{ value: "16:9", label: "16:9" },
					{ value: "9:16", label: "9:16" },
				],
				defaultValue: "16:9",
			},
			{
				key: "resolution",
				label: "分辨率",
				type: "select",
				options: [
					{ value: "720p", label: "720p" },
					{ value: "1080p", label: "1080p" },
				],
				defaultValue: "720p",
			},
			{
				key: "durationSeconds",
				label: "时长",
				control: "slider",
				type: "number",
				minimum: 2,
				maximum: 12,
				step: 1,
				unit: "秒",
				defaultValue: 5,
			},
			{
				key: "generateAudio",
				label: "生成音频",
				type: "boolean",
				defaultValue: true,
			},
		],
		seedance2_0: [
			{
				key: "ratio",
				label: "画幅比例",
				type: "select",
				options: [
					{ value: "16:9", label: "16:9" },
					{ value: "9:16", label: "9:16" },
				],
				defaultValue: "16:9",
			},
			{
				key: "durationSeconds",
				label: "时长",
				control: "slider",
				type: "number",
				minimum: 2,
				maximum: 12,
				step: 1,
				unit: "秒",
				defaultValue: 5,
			},
		],
	},
	defaultsByModel: {
		seedance2_5: { ratio: "16:9", resolution: "720p", durationSeconds: 5, generateAudio: true },
		seedance2_0: { ratio: "16:9", durationSeconds: 5 },
	},
};

/** 音频任务默认参数配置。 */
export const AUDIO_MODEL_CONFIG: ExecutionPanelModelConfig = {
	modelOptions: [
		{ value: "minimax-tts", label: "MiniMax 语音" },
		{ value: "doubao-tts", label: "豆包语音" },
		{ value: "music", label: "音乐生成" },
	],
	defaultModel: "minimax-tts",
	parameterSchemaByModel: {
		"minimax-tts": [
			{
				key: "voice",
				label: "音色",
				type: "select",
				options: [
					{ value: "female-warm", label: "温暖女声" },
					{ value: "male-deep", label: "沉稳男声" },
				],
				defaultValue: "female-warm",
			},
		],
		"doubao-tts": [],
		music: [
			{
				key: "durationSeconds",
				label: "时长",
				control: "slider",
				type: "number",
				minimum: 10,
				maximum: 120,
				step: 5,
				unit: "秒",
				defaultValue: 30,
			},
		],
	},
	defaultsByModel: {
		"minimax-tts": { voice: "female-warm", audioMode: "minimax-tts" },
		"doubao-tts": { audioMode: "doubao-tts" },
		music: { durationSeconds: 30, audioMode: "music" },
	},
};

export const DEFAULT_MODEL_CONFIG_BY_KIND: Record<
	ExecutionPanelTaskKind,
	ExecutionPanelModelConfig
> = {
	"text-generation": TEXT_MODEL_CONFIG,
	"image-generation": IMAGE_MODEL_CONFIG,
	"video-generation": VIDEO_MODEL_CONFIG,
	"audio-generation": AUDIO_MODEL_CONFIG,
};
