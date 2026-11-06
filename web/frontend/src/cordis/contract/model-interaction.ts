/**
 * 模型交互插件契约
 * （change: 2026-09-29-add-pluggable-model-interactions，任务 3.1 / design D3 / D4）。
 *
 * Platform 只定义**受信任本地 Cordis Plugin** 的 React Panel 与 registry contract：
 * - `ModelInteractionDefinition`：`{ id, version, owner, Panel }`，由 Plugin 在 activation 中注册；
 * - `ModelPanelProps`：Host 提供给 Panel 的**受限**能力（不是布局 DSL）；
 * - `ModelInteractionRegistry`：精确 `{id,version}` 解析、稳定诊断 list。
 *
 * 这里刻意**不**引入 JSON/布局 DSL、不提供 module URL / dynamic import / 远程 component loader。
 */
import type { ComponentType } from "react";
import type { CanvasTaskCatalogModel } from "@woohaa3/contracts";

/** 执行状态（与 ExecutionPanelStatus 对齐，但不依赖 feature 类型）。 */
export type ModelExecutionStatus =
  | "idle"
  | "pending"
  | "processing"
  | "successed"
  | "failed";

export type ExecutionPanelPresentation = import("../navigation/contracts.js").ExecutionPanelPresentation;

/** 受控 draft：Panel 可读、通过 patchDraft 写。 */
export type ModelExecutionDraft = {
  prompt: string;
  parameters: Record<string, unknown>;
};

export type ModelExecutionDraftPatch = Partial<ModelExecutionDraft>;

/** 参考项（Host 已从 canonical 解析；Panel 只读展示）。 */
export type ModelReferenceItem = {
  sourceNodeId: string;
  slotId: string;
  role: string;
  label: string;
  status: "ready" | "missing" | "pending" | "failed";
  mediaKind?: "image" | "video" | "audio" | "text";
  previewUrl?: string;
};

/** Panel 提交意图：只有 prompt/parameters；Host 补齐 nodeId/modelKey/runId。 */
export type ModelSubmitDraft = {
  prompt: string;
  parameters: Record<string, unknown>;
};

export type ModelSubmitOutcome =
  | { ok: true; runId: string; jobId: string }
  | { ok: false; error: string };

/** Panel 请求 presentation 变化（expand/collapse/close）。 */
export type PanelPresentationIntent =
  | { kind: "expand" }
  | { kind: "collapse" }
  | { kind: "close" }
  | { kind: "none" };

/**
 * Host 提供给 Model Panel 的**受限** props。
 *
 * Panel 拿不到 raw Y.Doc、Provider client、credentials、Task internal client 或 canonical
 * state setter。需要写 Canvas 时只能通过 Plugin 自己注入的 CanvasSession 提交明确命令，
 * 由 Plugin 创建受控 callback 交给 Panel。
 */
export type ModelPanelProps = {
  nodeId: string;
  model: CanvasTaskCatalogModel;
  /** 同 panel 类型的全部 catalog 模型（含默认交互之外的），供带模型选择器的 Panel 复用。 */
  catalogModels: readonly CanvasTaskCatalogModel[];
  defaultModelKey: string;
  writable: boolean;
  /**
   * 会话级只读（断线只读等）。
   *
   * 只读通过 `writable=false` 与 `readOnly=true` 同时表达：`writable` 允许 Panel 隐藏/
   * 灰化写操作，`readOnly` 让 Panel 保持主操作**真正禁用**，但 MUST NOT 把只读当成面板
   * 输入问题在面板里重复说明（该状态由宿主级同步状态控件承载）。
   */
  readOnly: boolean;
  presentation: ExecutionPanelPresentation;
  status: ModelExecutionStatus;
  /**
   * 视频节点从未提交过任务（无 active run、无产出、未进入终态）。
   *
   * Panel 据此显示「未提交 · 待配置」，而不是把空节点读成成功或泛化失败
   * （change: 2026-11-06-guard-video-generation-inputs）。
   */
  unsubmitted?: boolean;
  /** 权威节点任务进度，百分比 0–100；未提供时只显示阶段。 */
  progress?: number;
  /** 失败态的安全错误信息（可选）。 */
  errorMessage?: string;
  draft: Readonly<ModelExecutionDraft>;
  references: readonly ModelReferenceItem[];
  blockingReasons: readonly string[];
  /** 已确认的模型专用状态摘要（例如 Seedance intent chips）；Panel 只读展示。 */
  statusSummary?: readonly string[];
  patchDraft(patch: ModelExecutionDraftPatch): void;
  submit(input: ModelSubmitDraft): Promise<ModelSubmitOutcome>;
  requestPresentation(intent: PanelPresentationIntent): void;
  /** Plugin 提供的可选受控动作（例如打开模型 Dialog）；由 Plugin closure 实现。 */
  actions?: Readonly<Record<string, (arg?: string) => void>>;
  /**
   * Host 提供的通用执行 UI 片段工厂（references chips / 结构化 prompt editor）。
   *
   * 这些是**通用节点执行组件**（非布局 DSL）；Panel 可选用它们复用核心外观，
   * 也可完全自定义布局而忽略。
   */
  renderers?: ModelPanelRenderers;
};

export type ModelPanelRenderers = {
  references?: () => import("react").ReactNode;
  promptEditor?: (args: {
    value: string;
    onChange: (next: string) => void;
    disabled: boolean;
    placeholder: string;
    /** Enter 生成：与面板主操作共用提交门禁。 */
    onSubmit?: () => void;
  }) => import("react").ReactNode;
  /** 快捷改写（提示词工具）回调；可选，由 Host 注入。 */
  promptSkill?: (input: { id: string; label: string; prompt: string }) => void | Promise<void>;
};

export type ModelPanelComponent = ComponentType<ModelPanelProps>;

/** 注册项：Plugin 在 activation 中以 owner-scoped disposer 注册。 */
export type ModelInteractionDefinition = {
  id: string;
  version: number;
  owner: string;
  Panel: ModelPanelComponent;
  /**
   * Plugin 可选的受控绑定：由 Host 在解析后调用，为 Panel 提供 `actions`（打开 Plugin 自己的
   * Dialog 等）与 `statusSummary`（已确认的模型专用状态摘要）。这样专用逻辑留在 Plugin 内，
   * Host 与其它 Plugin 都不需要知道具体模型。
   */
  bindings?: (input: {
    nodeId: string;
    modelKey: string;
    canvas: import("@woohaa3/contracts").ServerCanvas | null;
  }) => ModelPanelBinding;
};

export type ModelPanelBinding = {
  actions?: Readonly<Record<string, (arg?: string) => void>>;
  statusSummary?: readonly string[];
};

/** 稳定、只读、不含 React component/closure 的诊断摘要。 */
export type ModelInteractionSummary = {
  id: string;
  version: number;
  owner: string;
};

export type ModelInteractionDescriptor = { id: string; version: number };

export interface ModelInteractionRegistry {
  /** 注册一个 definition；返回幂等 disposer，重复 `{id,version}` 稳定拒绝。 */
  register(definition: ModelInteractionDefinition): () => void;
  /** 精确 `{id,version}` 解析；不隐式替代 generic。 */
  resolve(descriptor: ModelInteractionDescriptor): ModelInteractionDefinition | null;
  /** 稳定顺序的诊断摘要（不含 component/closure）。 */
  list(): readonly ModelInteractionSummary[];
  /**
   * 订阅注册/注销变化（change: 2026-10-04-...，任务 5.3）：Host 据此重新解析当前 interaction。
   * 返回取消订阅函数；dispose 时清理全部 listener。
   */
  subscribe(listener: () => void): () => void;
}
