/**
 * Model Execution Host 的公开契约
 * （change: 2026-09-29-add-pluggable-model-interactions，任务 4.1 / design D4）。
 *
 * Host 只负责通用所有权（selection、working/canonical 投影、catalog lookup、references、
 * task status、writable、presentation、draft store、error boundary、submit boundary）。
 * 具体模型 React UI 由 Model Interaction Plugin 通过 Registry 提供的组件渲染。
 */
import type { ExecutionPanelPresentation } from "../../navigation/contracts.js";
import type { PanelPresentationIntent } from "./node-panel-directives.js";
import type {
  CanvasRemoteService,
  CanvasSession,
  DialogsService,
  PromptSnippetSource,
  TaskCatalogService
} from "../../contracts.js";
import type { CanvasRuntimeService } from "../../contracts.js";
import type { ModelInteractionRegistry } from "../../contract/model-interaction.js";
import type { ModelDraftStore } from "./model-draft.js";
import type { TaskActivityEventSink, SubmitCoordinator } from "./submit-coordinator.js";
import type { ModelSubmitOutcome } from "../../contract/model-interaction.js";

export type { ModelSubmitOutcome, ModelDraftStore };

export type ModelExecutionHostProps = {
  /** 当前画布 id（run/cancel 路径用）。 */
  canvasId?: string;  /** Canvas Navigation active panel route 传入的当前选中节点。 */
  selectedNodeId: string | null;
  runtime?: CanvasRuntimeService;
  /** 页面级画布会话（参数提交与引用连线用）。 */
  session: CanvasSession;
  /** Canvas 远端（run/cancel）。 */
  runClient: CanvasRemoteService;
  submitCoordinator?: SubmitCoordinator;
  /** 画布是否可写（断线只读时禁用）。 */
  writable: boolean;
  /**
   * T10: optional world-camera id whose framing this generation consumes. The Host
   * freezes that exact version before submitting; all versions/media stay server-side.
   */
  captureCameraId?: string;
  /** Dialog 能力（Alert 等通用对话框）。 */
  dialogs: DialogsService;
  /** 只读任务目录。 */
  catalog: TaskCatalogService;
  /** 模型交互 Registry（page-scoped Service）。 */
  registry: ModelInteractionRegistry;
  /** 受控草稿 store（可注入；缺省使用页面单例）。 */
  draftStore?: ModelDraftStore;
  /** 片段引用来源（`#` 引用）。 */
  snippetSource?: PromptSnippetSource;
  /**
   * 快捷改写的执行者（宿主从 `execution.prompt-skill` slot 注入）。
   *
   * 与 `onPromptSkill` 的区别：这里只负责产出改写后的文本，**写回草稿由 Host 完成**；
   * 面板的进行中/错误状态也由 Host 统一呈现。
   */
  promptSkill?: (input: {
    skill: { id: string; label: string; description?: string };
    prompt: string;
    canvasId: string;
    nodeId: string;
    taskKind: string;
  }) => Promise<{ prompt: string } | { error: string }>;
  /** 兼容：外部直接接管快捷改写（showcase fixture 记录 action 用）。 */
  onPromptSkill?: (input: { id: string; label: string; prompt: string }) => void | Promise<void>;
  /** 当前 panel presentation（生产由 Canvas Navigation route 提供）。 */
  presentation?: ExecutionPanelPresentation;
  /** 提交一次 panel presentation/close intent（expand / collapse / close）。 */
  onPresentationIntent?: (intent: PanelPresentationIntent) => void;
  /** 任务活动 typed 事件出口。 */
  activity?: TaskActivityEventSink;
  /**
   * 本地参数动作完成回调（change: 2026-10-09-improve-canvas-workflow，任务 1.6）。
   * 拖动滑块/文本确认结束时调用一次，供页面 Edit Journal 记录可撤销的参数条目。
   */
  onParameterGesture?: (input: {
    nodeId: string;
    modelKey: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    apply: (values: Record<string, unknown>) => void;
  }) => void;
  /**
   * 模型专用 Panel 的附加受控动作（由 Plugin 注入的受控 callback）。
   * Host 只转发给 Panel，不解释；用于 Plugin 打开自己的 Dialog。
   */
  panelActions?: Readonly<Record<string, (arg?: string) => void>>;
  /**
   * Host 为 Panel 提供的 statusSummary（已确认的模型专用状态摘要），
   * 例如 Seedance intent chips。由 Plugin 注入的投影函数计算。
   */
  resolveStatusSummary?: (input: {
    nodeId: string;
    modelKey: string;
    canvas: import("@woohaa3/contracts").ServerCanvas | null;
  }) => readonly string[];
};
