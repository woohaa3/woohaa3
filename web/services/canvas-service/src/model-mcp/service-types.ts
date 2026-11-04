/**
 * 模型 MCP 服务：DTO、依赖与共享类型
 * （自 `service.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R03）。
 *
 * 纯类型/常量模块；服务协作者共享同一 `ModelMcpServiceDependencies` 与结果类型，保持
 * 唯一 request lifecycle 与权威 room 写入方。
 */
import type { CanvasRoom } from "../sync/index.js";
import type {
  ModelCamera,
  ModelCameraMutation,
  ModelContentVersion,
  ModelReferenceInput,
  NodeHistoryModelPlacement,
  SupportedModelScriptVersion
} from "@woohaa3/contracts";
import type { CanvasCommandBatch } from "@woohaa3/contracts/canvas-yjs";
import type { RenderCache, RendererClient } from "../model-renderer/index.js";
import type { ScriptExecutorOptions } from "./script-executor.js";

export type SubmitScriptInput = {
  expectedContentHash?: string;
  canvasId: string;
  nodeId: string;
  source: string;
  /** 目标脚本版本；省略时使用首选版本（V2）。 */
  version?: SupportedModelScriptVersion;
  /**
   * 稳定请求身份（change: 2026-10-06-fix-animation3d-runtime-and-authoring，任务 5.1/5.2；
   * change: 2026-10-09-refactor-large-source-files-and-remove-compatibility A09 —— 改为必填）。
   */
  requestId: string;
  /** 模型内容 precondition；在 room 串行队列内检查，拒绝并发覆盖。 */
  expectedModelContentHash?: string;
};

/** 模型规模统计输入（change: 2026-10-18-align-model-statistics-with-agent）。 */
export type ModelStatisticsInput = {
  canvasId: string;
  nodeId: string;
  /** 省略统计当前权威脚本；提供则只统计候选，不写画布。 */
  source?: string;
};

export type ModelStatisticsOutcome =
  | {
      ok: true;
      canvasId: string;
      nodeId: string;
      source: "current" | "candidate";
      statistics: import("@woohaa3/contracts").ModelSceneStatistics;
      breakdown: import("@woohaa3/contracts").ModelSceneStatisticsBreakdown;
    }
  | { ok: false; code: string; message: string };

/** 脚本长度上限（避免超大 payload 进入 Y.Doc）。 */
export const MODEL_SCRIPT_MAX_CHARS = 200_000;

export type SubmitScriptOutcome =
  | {
      ok: true;
      canvasId: string;
      nodeId: string;
      commandId: string;
      idempotent: boolean;
      /** 提交脚本的规模统计（与模型聚焦信息面板同源）。 */
      statistics?: import("@woohaa3/contracts").ModelSceneStatistics;
      breakdown?: import("@woohaa3/contracts").ModelSceneStatisticsBreakdown;
    }
  | { ok: false; code: string; message: string };

export type ReportScriptOutcome =
  | { ok: true; canvasId: string; nodeId: string; commandId: string }
  | { ok: false; code: string; message: string };

export type GetModelNodeInput = {
  expectedContentHash?: string;
  canvasId: string;
  nodeId: string;
  /**
   * 附带当前脚本的规模统计（默认 false）。
   *
   * change: 2026-10-18-align-model-statistics-with-agent —— 读取默认不执行脚本；
   * 需要与聚焦面板对齐的数字时显式请求。
   */
  includeStatistics?: boolean;
};

export type GetModelNodeOutcome =
  | {
      ok: true;
      canvasId: string;
      nodeId: string;
      nodeType?: string;
      contentHash?: string;
      modelContentVersion?: ModelContentVersion;
      /** 文件模型（GLB）来源标记；脚本模型省略（change: 2026-10-28-support-glb-model-nodes）。 */
      modelSourceKind?: "glb";
      /** 文件模型引用的画布资产 id；脚本模型省略。 */
      modelAssetId?: string;
      placement?: NodeHistoryModelPlacement;
      snapshotHash?: string;
      title: string;
      prompt: string;
      source: string;
      language?: string;
      version?: string;
      status?: "ok" | "failed";
      error?: string | null;
      references: ModelReferenceInput[];
      cameras: ModelCamera[];
      /** 当前权威脚本的规模统计（与聚焦信息面板同源）；脚本为空或执行失败时省略。 */
      statistics?: import("@woohaa3/contracts").ModelSceneStatistics;
      breakdown?: import("@woohaa3/contracts").ModelSceneStatisticsBreakdown;
    }
  | { ok: false; code: string; message: string };

/** 一个 3D 作者节点的列表条目（从权威画布派生）。 */
export type ModelNodeSummary = {
  nodeId: string;
  nodeType?: string;
  title: string;
  prompt: string;
  references: ModelReferenceInput[];
  hasScript: boolean;
  /** 文件模型（GLB）标记；脚本模型省略。 */
  sourceKind?: "glb";
  status?: "ok" | "failed";
  /** 是否仍缺可执行内容；文件模型只按状态判定（不要求脚本）。 */
  pending: boolean;
  cameraCount: number;
};

export type ListModelNodesOutcome =
  | { ok: true; canvasId: string; nodes: ModelNodeSummary[] }
  | { ok: false; code: string; message: string };

/** 预览请求：只接受节点标识与受限 capture options（design D12）。 */
export type RenderPreviewInput = {
  canvasId: string;
  nodeId: string;
  width?: number;
  height?: number;
  background?: string;
  cameraPreset?: string;
  /** 采样时刻（秒）；静态模型只接受 0。 */
  timeSeconds?: number;
};

/** 预览元数据：防陈旧且可追溯。 */
export type RenderPreviewMetadata = {
  canvasId: string;
  nodeId: string;
  sourceHash: string;
  sceneSignature: string;
  sceneVersion: string;
  renderVersion: string;
  width: number;
  height: number;
  background: string;
  cameraPreset: string;
};

export type RenderPreviewOutcome =
  | { ok: true; pngBase64: string; metadata: RenderPreviewMetadata; cached: boolean }
  | { ok: false; code: string; message: string };

/** 通用语义命令提交输入（change: split-model-mcp-into-mcp-service）。 */
export type ApplyCommandsInput = {
  canvasId: string;
  commandId: string;
  baseRevision: number;
  commands: CanvasCommandBatch["commands"];
};

export type ApplyCommandsOutcome =
  | { ok: true; canvasId: string; commandId: string; duplicate: boolean; noop: boolean }
  | { ok: false; code: string; message: string };

/** 单条镜头变更输入（change: add-model-camera-mcp-crud）。 */
export type MutateCamerasInput = {
  canvasId: string;
  nodeId: string;
  requestId: string;
  mutation: ModelCameraMutation;
};

export type MutateCamerasOutcome =
  | {
      ok: true;
      canvasId: string;
      nodeId: string;
      commandId: string;
      duplicate: boolean;
      noop: boolean;
      cameras: ModelCamera[];
    }
  | { ok: false; code: string; message: string };

/** 批量镜头变更输入（change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 4.4）。 */
export type MutateCamerasBatchInput = {
  canvasId: string;
  nodeId: string;
  requestId: string;
  mutations: readonly ModelCameraMutation[];
};

export type MutateCamerasBatchOutcome =
  | {
      ok: true;
      canvasId: string;
      nodeId: string;
      commandId: string;
      duplicate: boolean;
      noop: boolean;
      cameras: ModelCamera[];
    }
  | { ok: false; code: string; message: string; failedIndex?: number };

export type ModelMcpServiceDependencies = {
  resolveRoom: (canvasId: string) => Promise<CanvasRoom | null>;
  /** 稳定 commandId 生成器（测试可注入确定性实现）；默认由内容哈希派生。 */
  createCommandId?: (input: SubmitScriptInput) => string;
  now?: () => string;
  /** 原生渲染器 client；省略时预览返回 renderer-unavailable。 */
  rendererClient?: RendererClient;
  /** 预览 PNG 有界缓存；省略时创建默认缓存。 */
  renderCache?: RenderCache;
  /** 脚本执行预算与测试注入。 */
  scriptExecutor?: ScriptExecutorOptions;
  /**
   * 模型历史登记端口（change: add-canvas-node-generation-history，任务 2.3）。
   */
  registerModelHistory?: (input: {
    canvasId: string;
    nodeId: string;
    sourceHash: string;
    modelScript: string;
    language: string;
    version: string;
    createdAt: string;
    nodeType?: string;
    placement?: NodeHistoryModelPlacement;
  }) => Promise<unknown>;
  /** 写入审计用的 actorId。由**调用方身份**派生。 */
  actorId?: string;
};

/** 稳定短哈希（无外部依赖）。 */
export function hashText(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}
