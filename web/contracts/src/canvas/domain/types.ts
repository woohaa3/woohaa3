import type { Woohaa3CanvasDocument,
  Woohaa3CanvasJsonObject,
  Woohaa3CanvasNodeDataMap } from "./core";
import type { VideoEditIntent } from "../../video/video-edit.js";
import type { ModelCamera } from "../model-cameras.js";
import type { ImageEditDocument } from "../image-edit.js";

export type GenerationKind = "text" | "image" | "video" | "audio";
export type GenerationStatus = "idle" | "queued" | "running" | "success" | "failed" | "draft" | "ready" | "archived";

export type GenerationResult = {
  kind: GenerationKind;
  text?: string;
  url?: string;
  posterUrl?: string;
  durationSeconds?: number;
};

export type CanvasNodeInputMapping = {
  slotId?: string;
  sourceNodeId: string;
  sourceAssetIds?: string[];
  role: string;
  sortKey?: string;
  label?: string;
};

export type CanvasNodeData = Woohaa3CanvasJsonObject & {
  /** Neutral extension-owned lifecycle relation. Business payload stays opaque. */
  managedBy?: import("../managed-node.js").ManagedNodeRelation;
  title?: string;
  taskKind?: string;
  prompt?: string;
  panelPrompt?: string;
  inputMapping?: CanvasNodeInputMapping[];
  status?: GenerationStatus;
  taskStatus?: "idle" | "pending" | "processing" | "successed" | "failed" | "cancelled" | "unknown";
  /**
   * 当前节点的 active run（客户端生成）。任务结果只有在它与返回结果的 runId 一致时
   * 才被接受（latest-run-wins，change: add-image-text-node-execution）。
   */
  activeRunId?: string;
  /** 最近一次执行使用的稳定 modelKey。 */
  modelKey?: string;
  progress?: number;
  /** `null` 表示显式清除上一次的错误（同一次提交里清掉失败态再进入 processing）。 */
  error?: string | null;
  errorMessage?: string | null;
  result?: GenerationResult;
  resultPreview?: GenerationResult;
  providerTaskId?: string;
  durationSeconds?: number;
  mediaContent?: import("../media-content.js").MediaContentRef;
  outputAssetId?: string;
  /**
   * 浏览器本地历史预览的失败信息。
   *
   * 只在 node-history 的 `ExecutionPreview` 渲染投影中写入：选中失败/取消归档时，卡片正文
   * 用它替代上一个成功输出显示安全原因。**不进入** Y.Doc、ServerCanvas 或任何权威写入。
   */
  historyPreviewFailure?: {
    outcome: "failed" | "cancelled" | "interrupted" | "partial";
    message: string;
  };
  /** 视频结果的可选海报资产引用（稳定 asset ID）。 */
  posterAssetId?: string;
  resourceKind?: string;
  /**
   * 模型节点的模型脚本（change: replace-godot-canvas-runtime-with-bevy）。
   *
   * 规范定义是**版本化 JavaScript**（`modelScriptLanguage: "javascript"`、
   * `modelScriptVersion: "woohaa-model-js-v2"`），由浏览器注入 SceneBuilder API 执行，
   * 结果经 Scene IR validator 校验后送给 Bevy。唯一权威写入方是 Canvas Service 的
   * model MCP；进入 Y.Doc 后在重新投影时继续生效。Scene IR 只是运行时 DTO，**不**在此持久化。
   */
  modelScript?: string;
  /** 脚本语言；写入必须为 `"javascript"`。 */
  modelScriptLanguage?: string;
  /** 脚本语言版本；写入必须为受支持的 `woohaa-model-js-v*`。 */
  modelScriptVersion?: string;
  /** 模型脚本应用状态；与任务的 `taskStatus` 分离（任务终态仍由 projector 独占）。 */
  modelScriptStatus?: "ok" | "failed";
  /** 模型脚本应用失败的安全错误信息（不包含本机路径或堆栈）。 */
  modelScriptError?: string | null;
  /**
   * 普通 `model3d` 的权威来源判别（change: 2026-10-28-support-glb-model-nodes）。
   *
   * 缺失表示脚本模型（与历史内容兼容）；`"glb"` 表示以画布资产 `modelAssetId` 中的原始
   * GLB 为权威内容，此时节点不得保存任何 `modelScript*` 字段。
   */
  modelSourceKind?: "glb";
  /** 文件模型引用的画布作用域资产 id（内容寻址、稳定；不写二进制或临时 URL）。 */
  modelAssetId?: string;
  frozenPreview?: GenerationResult;
  /**
   * 视频编辑意图（change: port-video-editing-dialogs，design D4/D6）。
   *
   * 只在 `parameters.generationMode === "edit_video"` 时使用。canonical 状态只保存
   * 结构化 intent 与**稳定** annotation preview identity，绝不保存 data URL、object URL、
   * Blob 或临时签名 URL（由 `sanitizeVideoEditIntents` 强制）。
   */
  videoEditIntents?: VideoEditIntent[];
  /**
   * 图片节点的当前编辑定义
   * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，design D4）。
   *
   * 只保存**当前版本**的严格定义（稳定原图引用、源尺寸、归一化 shapes）；`outputAssetId`
   * 指向稳定合成输出。绝不含图片 bytes、Blob、URL、草稿栈或编辑 UI 状态。无此字段的合法
   * 旧图继续作为纯媒体读取。完整历史集合由 canvas-node-generation-history 持有。
   * `null` 显式清除（恢复纯媒体版本时）。
   */
  imageEdit?: ImageEditDocument | null;
  /**
   * 模型节点的镜头子资源（change: add-model-editor-gizmo-shot-capture，design D2）。
   *
   * 只保存 `id/name/order/azimuth/distance`；固定仰角、派生 AABB focus、投影与 fit span
   * 是版本化行为。由 `decodeModelCameras` / runtime allowlist 强制校验，绝不写入
   * selection、preview URL、Blob 或 GPU 对象。
   */
  modelCameras?: ModelCamera[];
  parameters?: Record<string, unknown>;
};

export type CanvasNodeDataMap<TNodeData extends Woohaa3CanvasJsonObject = CanvasNodeData> =
  Woohaa3CanvasNodeDataMap<TNodeData>;

export type CanvasMediaKind = "image" | "video" | "audio" | "text" | "storyboard" | "file";
export type CanvasAssetSource = "generated" | "uploaded" | "external";
export type CanvasAssetStatus = "ready" | "generating" | "needs-review" | "missing" | "failed";

export type CanvasAsset = {
  id: string;
  title: string;
  mediaKind: CanvasMediaKind;
  source: CanvasAssetSource;
  status: CanvasAssetStatus;
  /** Whether this asset is saved in the current canvas generation history. */
  isFavorite?: boolean;
  prompt?: string;
  url?: string;
  posterUrl?: string;
  text?: string;
  durationSeconds?: number;
  progress?: number;
  error?: string;
  provenance?: {
    taskNodeId?: string;
    taskKind?: string;
    runId?: string;
    outputIndex?: number;
  };
  tags?: string[];
  metadata?: Record<string, unknown>;
};

export type StoredCanvas<TNodeData extends Woohaa3CanvasJsonObject = CanvasNodeData> = {
  id: string;
  title?: string;
  revision: number;
  document: Woohaa3CanvasDocument;
  nodeData: Woohaa3CanvasNodeDataMap<TNodeData>;
  updatedAt: string;
};

export type StoredAsset = CanvasAsset & {
  nodeId?: string;
  createdAt: string;
  providerTaskId?: string;
  /** Optional name owned by a generation-history entry, independent of asset.title. */
  historyTitle?: string;
};

export type StoredJob = {
  id: string;
  nodeId: string;
  taskId: string;
  /** 该次运行使用的稳定模型身份；用于从历史/产物反查（change: l0-generation-provenance）。 */
  modelKey?: string;
  /** 客户端生成的任务运行 id；与 nodeData.activeRunId 对应（latest-run-wins）。 */
  runId?: string;
  /**
   * T10 frozen world-capture input for this run. It is written once at durable
   * acceptance and never rewritten by later canvas changes.
   */
  worldCapture?: import("../world-capture-pipeline-contract.js").WorldCaptureGenerationBinding;
  status: GenerationStatus;
  error?: string;
  updatedAt: string;
};

export type ServerCanvas<TNodeData extends Woohaa3CanvasJsonObject = CanvasNodeData> = StoredCanvas<TNodeData> & {
  assets: StoredAsset[];
  jobs: StoredJob[];
};

export const DEFAULT_CANVAS_TITLE = "未命名画布";
