/**
 * Feature-owned service key 常量（change: adopt-frontend-cordis-plugin-runtime）。
 *
 * 平台 Service 的类型在 `runtime/types.ts` 的 Context 增强中声明；这里放**feature 之间**
 * 通过 Context 查找的稳定 key，避免一个 feature 直接 import 另一个 feature 的单例。
 */

/** 只读画面场景服务（由 model-scene plugin 提供）。 */
export type ModelScenesProvider = {
  /**
   * 每节点的不可变 prepared model resource（change: optimize-model-scene-snapshot-hot-path）。
   * 画布帧只引用其 resourceKey；完整 Scene IR 经独立注册通道下发。
   */
  getResources(): ReadonlyMap<string, import("@woohaa3/contracts").PreparedModelResource>;
  /** 本地模型资源正在排队/准备；不包含远端执行状态上报的等待。 */
  isLoading?(nodeId: string): boolean;
  subscribe(listener: () => void): () => void;
  /**
   * feature 提供的**非 canonical 临时模型快照**节点集合（change: add-model-focus-editing，
   * 任务 3.4）。这些节点仍可聚焦查看，但禁止 placement 编辑。缺省为空。
   */
  nonCanonicalNodes?(): ReadonlySet<string>;
};

export const MODEL_SCENES_SERVICE = "modelScenes";

export const IMPORT_SERVICE = "importService";

/**
 * 片段引用来源（由 prompt-snippets extension 提供；change: add-prompt-snippet-library）。
 *
 * Task Execution 的 `#` 引用按此 key 查找；optional 插件缺失时不出现 `#` 入口，普通
 * prompt 编辑继续工作。key 常量与来源契约迁至公共 extension-api leaf（change:
 * 2026-10-10-extract-optional-feature-extensions，design D4），宿主与扩展共享同一常量，避免
 * task-execution 直接 import 片段插件实现。
 */
export { PROMPT_SNIPPET_SOURCE } from "../../extension-api/capability-keys.js";

/** 节点历史 feature capability（由 Node History Plugin 提供）。 */
export const NODE_HISTORY_SERVICE = "nodeHistory";
export const INLINE_HISTORY_SERVICE = "inlineHistoryVersions";
export type InlineHistoryService = Pick<import("./node-history/inline-versions.js").InlineVersions, "snapshot" | "subscribe" | "select" | "activate" | "preview" | "refreshNode" | "markSeenNode" | "unseenSnapshot" | "selectedByNode">;

/**
 * 模型编辑 gizmo/镜头工具栏 feature capability
 * （change: add-model-editor-gizmo-shot-capture）。
 */
export const MODEL_EDITOR_SERVICE = "modelEditor";

export type ModelEditorService = {
  session: import("../../extension-api/model-workspace-session.js").ModelEditorSession;
  close(): void;
  getState(): import("../../extension-api/model-workspace-session.js").ModelEditorSessionState;
};

/**
 * 片场对象编辑 feature capability
 * （change: 2026-10-09-add-film-set-object-motion-and-editing）。
 */


/**
 * 图片聚焦编辑 feature capability
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history；
 *   change: 2026-10-27-add-image-history-to-photocraft-focus，design D4）。
 *
 * key 与类型定义在公共 extension-api leaf，宿主与扩展共享同一契约：
 * `export * from "./capability-keys.js"` 已从 `@woohaa3/frontend/extension-api` 导出。
 */
export { IMAGE_EDIT_SERVICE, type ImageEditService } from "../../extension-api/capability-keys.js";
// 供下方 `resolveImagePreviewOwner` 读取 key（re-export 不引入本地绑定）。
import { IMAGE_EDIT_SERVICE } from "../../extension-api/capability-keys.js";

/**
 * 宿主默认图片查看 capability（由 image-viewer plugin 提供；
 * change: default-image-focus-viewer）。
 *
 * 图片编辑器扩展缺席时，历史面板仍需要「换到旧版本只读预览」的能力。本 key 与
 * `imageEdit` 同形（只实现只读子集），由 node-history 在编辑器缺席时回落使用；编辑器
 * 装入后始终优先 `imageEdit`。
 */
export const IMAGE_VIEW_SERVICE = "imageView";

/** 历史只读预览需要的动作（`ImageEditService` 的对应子集）。 */
export type ImagePreviewOwner = Pick<
  import("../../extension-api/capability-keys.js").ImageEditService,
  "isActive" | "nodeId" | "setHistoryOverride" | "draftState"
>;

/**
 * 当前可用的图片预览 owner：编辑器优先，缺席时回落宿主默认查看器。
 *
 * 放在 service-keys 而不是 node-history 内部：两个消费点（当前首项草稿态、历史 override）
 * 与 image-viewer 的 provide 共享同一解析语义，避免各写一份回落顺序。
 */
export function resolveImagePreviewOwner(
  ctx: Pick<import("@deepseek-ai/cordis").Context, "get">
): ImagePreviewOwner | undefined {
  const editor = ctx.get(IMAGE_EDIT_SERVICE as never) as ImagePreviewOwner | undefined;
  if (editor) return editor;
  return ctx.get(IMAGE_VIEW_SERVICE as never) as ImagePreviewOwner | undefined;
}

/**
 * 视频聚焦 feature capability（由 Video Focus Plugin 提供；
 * change: 2026-10-10-add-video-node-focus-workspace）。
 */
export const VIDEO_FOCUS_SERVICE = "videoFocus";

export type VideoFocusService = {
  isActive(): boolean;
  nodeId(): string | null;
  /** 安装/清除只读历史媒体 override（旧版本预览）。 */
  setHistoryOverride(override: { url: string } | null): void;
  /** 当前 canonical 输出远端改变后重新取景/暂停（保留帧与回执）。 */
  refreshFromCanonical(): void;
};

/**
 * group 批量执行 capability（由 Task Execution Plugin 提供；
 * change: add-canvas-node-grouping，任务 3.4b；
 * change: 2026-10-16-add-group-selection-toolbar，design D3/D4/D5/D6）。
 *
 * 横条的「批量执行」与右键的「批量执行」按此 key 查找同一 service；缺失时两者都不出现。
 * 该 service 是**跨 feature 契约**：分组提交业务实现（草稿、预检、锁、快照）留在
 * task-execution，横条/右键只消费本接口。
 */
export const GROUP_RUN_SERVICE = "groupRun";

/** 分组预览中单个成员的跳过类别（供摘要按类别折叠展示）。 */
export type GroupRunSkipCategory =
  | "not-runnable"
  | "running"
  | "model-unavailable"
  | "input-missing"
  | "invalidated";

export type GroupRunPreviewEntry = {
  nodeId: string;
  category: GroupRunSkipCategory;
  reason: string;
};

/**
 * 分组可提交预览（只读，不产生请求/runId/任务状态）。
 *
 * `count` 为 N（当前可提交且未运行/未被本地预占的叶子数）；`enabled` 综合写权限、目录与 N。
 */
export type GroupRunPreview = {
  groupId: string;
  count: number;
  skipped: GroupRunPreviewEntry[];
  enabled: boolean;
  /** 主动作禁用原因（`enabled` 为 false 时非空）。 */
  reason?: string;
};

/** 一批提交结束的结果摘要（绑定起始 canvasId/groupId）。 */
export type GroupRunSummary = {
  groupId: string;
  accepted: string[];
  skipped: Array<{ nodeId: string; reason: string }>;
  failed: Array<{ nodeId: string; error: string }>;
};

export type GroupRunService = {
  /** 只读预览当前可提交数量 N 与跳过原因；不发请求、不生成 runId。 */
  preview(groupNodeId: string): GroupRunPreview;
  /** 运行一个 group 的全部可运行叶子；返回 accepted/skipped/failed 摘要。 */
  runGroup(groupNodeId: string, origin?: import("./task-execution/execution-launch.js").ExecutionOrigin): Promise<GroupRunSummary>;
  /** 该分组是否正在编排一批请求（横条/右键共用的「提交中」门禁）。 */
  isSubmitting(groupNodeId: string): boolean;
  /** 订阅提交编排与预览相关状态变化；返回退订函数（随 page scope 释放）。 */
  subscribe(listener: () => void): () => void;
  /** 页面释放：停止未发出的请求并清理编排状态。 */
  dispose(): void;
};

/**
 * 统一生成运行状态 feature capability
 * （change: 2026-10-12-unify-generation-history-strip，design D1/D2）。
 *
 * 所有生成入口的唯一展示源：合并 task-activity（服务端 owner）与本地操作注册（local owner），
 * 输出按 `(canvasId,nodeId)` 索引的 `CanvasNodeRunSummary`。执行面板、历史底条与聚合遮罩
 * 都读它，不再各自维护 busy 布尔。
 */
export const RUN_STATE_SERVICE = "runState";

export type RunStateService = {
  /** 按 `(canvasId,nodeId)` 查询当前节点运行摘要；未知节点返回不存在。 */
  getNodeSummary(canvasId: string, nodeId: string): import("@woohaa3/contracts").CanvasNodeRunSummary | null;
  /** 订阅摘要变化（React/投影用）。 */
  subscribe(listener: () => void): () => void;
  /** 当前快照（供 scene 投影批量读取）。 */
  snapshot(): {
    canvasId: string;
    summaries: ReadonlyMap<string, import("@woohaa3/contracts").CanvasNodeRunSummary>;
    records: readonly import("@woohaa3/contracts").CanvasOperationRecord[];
  };
  /** 该 `(canvasId,nodeId)` 是否已有运行中操作（门禁用）。 */
  isBusy(canvasId: string, nodeId: string): boolean;
  /**
   * “当前生效版本”对应的操作身份映射（`nodeId -> operationId`）
   * （change: 2026-10-12-unify-generation-history-strip，design D4）。
   *
   * 有界派生：不读取完整历史，只用 working canvas 的 `nodeData.activeRunId` 与该节点已成功
   * 结算的操作 identity 匹配。缺失/无法判定时不装饰，绝不本地猜测。
   */
  currentOperationByNode(): ReadonlyMap<string, string>;
  subscribeCurrentOperations(listener: () => void): () => void;
  /**
   * 注册一个浏览器本地生成操作（截图/帧捕获/视频导出/本地编码）。
   *
   * 返回一个 `finish` 回调，由本地编码结束时按成功/失败结算。本地操作不写 canonical，
   * 也不经 Task Service（design D8）。
   */
  beginLocalOperation(input: {
    canvasId: string;
    nodeId: string;
    kind: import("@woohaa3/contracts").CanvasOperationKind;
    progress?: number;
  }): { operationId: string; finish: (outcome?: { error?: string; progress?: number }) => void };
};

export type { ImportService, ImportState, ImportAnchor } from "../contracts.js";
export type { PromptSnippetSource, PromptSnippetSearchResult } from "../contracts.js";
