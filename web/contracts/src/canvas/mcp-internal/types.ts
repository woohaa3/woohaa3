/**
 * MCP Service ⇄ Canvas Service 内部协议：常量与 DTO 类型
 * （自 `mcp-internal.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R08）。
 *
 * 只承载稳定路径常量、协议版本与服务身份，以及请求/响应 DTO；解码器在 `*-codec` 叶子模块。
 * 不 import 任何 codec，避免经 barrel 形成环。
 */
import type { CanvasCommand } from "../commands.js";
import type { ModelReferenceInput } from "../domain/model-reference-inputs.js";
import type { ModelCamera, ModelCameraAspect, ModelCameraFocusOffset } from "../model-cameras.js";
import type { ModelSceneStatistics, ModelSceneStatisticsBreakdown } from "../scene-ir-v2/stats.js";

/** 内部协议基路径（不经公网 ingress；`/internal/*` 一律拒绝）。 */
export const MCP_INTERNAL_BASE_PATH = "/internal/v1/model-mcp" as const;

/** 内部协议版本；任何不兼容结构变化都要提升它。 */
export const MCP_INTERNAL_PROTOCOL_VERSION = 1 as const;

/** Canvas 侧为 MCP Service 调用派生并写入审计的 actorId。 */
export const MCP_INTERNAL_ACTOR_ID = "mcp-service" as const;

/** 受信任调用方必须携带的协议版本头。 */
export const MCP_INTERNAL_PROTOCOL_HEADER = "x-woohaa3-mcp-protocol-version" as const;

/** 单次内部请求的 JSON body 上限。 */
export const MCP_INTERNAL_MAX_BODY_BYTES = 12 * 1024 * 1024;

export const MCP_INTERNAL_PATHS = {
  listNodes: `${MCP_INTERNAL_BASE_PATH}/nodes/list`,
  getNode: `${MCP_INTERNAL_BASE_PATH}/nodes/get`,
  submitScript: `${MCP_INTERNAL_BASE_PATH}/scripts/submit`,
  reportScript: `${MCP_INTERNAL_BASE_PATH}/scripts/report`,
  renderPreview: `${MCP_INTERNAL_BASE_PATH}/preview`,
  applyCommands: `${MCP_INTERNAL_BASE_PATH}/commands`,
  mutateCameras: `${MCP_INTERNAL_BASE_PATH}/cameras/mutate`,
  mutateCamerasBatch: `${MCP_INTERNAL_BASE_PATH}/cameras/mutate-batch`,
  /**
   * 模型批量作者（model-script-batch）内部路径
   * （change: 2026-10-13-add-canvas-script-authoring）：批量读取、只校验、校验并提交。
   */
  getModelNodes: `${MCP_INTERNAL_BASE_PATH}/models/nodes`,
  validateModelScripts: `${MCP_INTERNAL_BASE_PATH}/models/validate`,
  submitModelScripts: `${MCP_INTERNAL_BASE_PATH}/models/submit`,
  /**
   * 模型规模统计（与聚焦面板同源；可为候选脚本预检）。
   * change: 2026-10-18-align-model-statistics-with-agent。
   */
  modelStatistics: `${MCP_INTERNAL_BASE_PATH}/models/statistics`
} as const;

// ---------------------------------------------------------------------------
// 请求 DTO
// ---------------------------------------------------------------------------

export type McpListNodesRequest = { canvasId: string };
export type McpGetNodeRequest = {
  canvasId: string;
  nodeId: string;
  /**
   * 附带当前脚本的规模统计（change: 2026-10-18-align-model-statistics-with-agent）。
   * 省略为 false：读取默认不执行脚本，保持轻量。
   */
  includeStatistics?: boolean;
};
export type McpSubmitScriptRequest = {
  canvasId: string;
  nodeId: string;
  source: string;
  version?: string;
  /**
   * model3d 编辑的稳定请求身份
   * （change: 2026-10-06-fix-animation3d-runtime-and-authoring，任务 5.1/5.2）；generate 可省略。
   */
  requestId?: string;
  /** model3d 编辑的模型内容 precondition；与当前内容不一致时拒绝并发覆盖。 */
  expectedModelContentHash?: string;
  expectedContentHash?: string;
};
export type McpReportScriptRequest = {
  canvasId: string;
  nodeId: string;
  status: "ok" | "failed";
  message?: string;
};

/**
 * 模型规模统计请求（change: 2026-10-18-align-model-statistics-with-agent）。
 *
 * `source` 省略时统计节点当前权威 modelScript；提供时只统计候选脚本，不写画布、不推进 revision。
 * 数值与模型聚焦信息面板共用 `modelSceneStatistics`，使 Agent 不必自行手算。
 */
export type McpModelStatisticsRequest = {
  canvasId: string;
  nodeId: string;
  source?: string;
};
export type McpRenderPreviewRequest = {
  canvasId: string;
  nodeId: string;
  width?: number;
  height?: number;
  background?: string;
  cameraPreset?: string;
  /** 动画节点采样时刻（秒）；缺省 0。 */
  timeSeconds?: number;
};

/**
 * 通用语义命令请求。刻意只带 `commandId` + `baseRevision` + 命令列表：
 * 服务端自行补 `protocolVersion` 与派生 `actorId`，因此调用方无法伪造来源。
 */
export type McpApplyCommandsRequest = {
  canvasId: string;
  commandId: string;
  baseRevision: number;
  commands: CanvasCommand[];
};

/**
 * 单条镜头变更意图（change: add-model-camera-mcp-crud）。
 *
 * MCP 只表达意图；Canvas 侧在 room 串行队列内读出权威集合、应用契约纯函数变更，再提交
 * 完整规范化 `nodeData.patch`。因此两个并发单条写入不会互相覆盖。
 */
export type McpCameraMutation =
  | {
      kind: "create";
      azimuth: number;
      distance: number;
      name?: string;
      elevation?: number;
      aspect?: ModelCameraAspect;
      focusOffset?: ModelCameraFocusOffset;
    }
  | {
      kind: "update";
      id: string;
      azimuth?: number;
      distance?: number;
      elevation?: number;
      aspect?: ModelCameraAspect;
      focusOffset?: ModelCameraFocusOffset;
    }
  | { kind: "remove"; id: string }
  | { kind: "rename"; id: string; name: string }
  | { kind: "reset"; id: string; azimuth: number; distance: number; elevation?: number };

export type McpMutateCamerasRequest = {
  canvasId: string;
  nodeId: string;
  requestId: string;
  mutation: McpCameraMutation;
};

/**
 * 批量镜头变更请求（change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 4.4）。
 *
 * 生成层一次提交受约束的镜头意图列表；Canvas 侧在权威串行边界整批原子应用。整批非法整批
 * 拒绝，绝不部分写入。
 */
export type McpMutateCamerasBatchRequest = {
  canvasId: string;
  nodeId: string;
  requestId: string;
  mutations: McpCameraMutation[];
};

// ---------------------------------------------------------------------------
// 响应 DTO
// ---------------------------------------------------------------------------

export type McpModelNodeSummary = {
  nodeId: string;
  nodeType?: string;
  title: string;
  prompt: string;
  references: ModelReferenceInput[];
  hasScript: boolean;
  status?: "ok" | "failed";
  pending: boolean;
  /** 当前规范镜头数量（change: add-model-camera-mcp-crud）；缺失或非法时为 0。 */
  cameraCount: number;
};

export type McpListNodesResult =
  | { ok: true; canvasId: string; nodes: McpModelNodeSummary[] }
  | { ok: false; code: string; message: string };

export type McpGetNodeResult =
  | {
      ok: true;
      canvasId: string;
      nodeId: string;
      nodeType?: string;
      contentHash?: string;
      diagnostic?: string;
      modelContentVersion?: { revision: number; sourceHash: string; contentHash: string };
      placement?: { offset: { x: number; y: number; z: number }; scale: number; yaw: number };
      snapshotHash?: string;
      title: string;
      prompt: string;
      source: string;
      language?: string;
      version?: string;
      status?: "ok" | "failed";
      error?: string | null;
      references: ModelReferenceInput[];
      /** 当前规范化镜头集合（change: add-model-camera-mcp-crud）；缺失或非法时为空数组。 */
      cameras: ModelCamera[];
      /**
       * 当前权威脚本的规模统计（change: 2026-10-18-align-model-statistics-with-agent）。
       * 与模型聚焦信息面板同一 `modelSceneStatistics`；脚本失败或为空时省略。
       */
      statistics?: ModelSceneStatistics;
      breakdown?: ModelSceneStatisticsBreakdown;
    }
  | { ok: false; code: string; message: string };

export type McpSubmitScriptResult =
  | {
      ok: true;
      canvasId: string;
      nodeId: string;
      commandId: string;
      idempotent: boolean;
      /**
       * 提交脚本的规模统计（change: 2026-10-18-align-model-statistics-with-agent）。
       * 与模型聚焦信息面板同源，供 Agent 直接引用而不自行估算。
       */
      statistics?: ModelSceneStatistics;
      breakdown?: ModelSceneStatisticsBreakdown;
    }
  | { ok: false; code: string; message: string };

/**
 * 模型规模统计结果（change: 2026-10-18-align-model-statistics-with-agent）。
 *
 * `source` 表示统计的是节点当前权威脚本（"current"）还是候选脚本（"candidate"）。
 */
export type McpModelStatisticsResult =
  | {
      ok: true;
      canvasId: string;
      nodeId: string;
      source: "current" | "candidate";
      statistics: ModelSceneStatistics;
      breakdown: ModelSceneStatisticsBreakdown;
    }
  | { ok: false; code: string; message: string };

export type McpReportScriptResult =
  | { ok: true; canvasId: string; nodeId: string; commandId: string }
  | { ok: false; code: string; message: string };

export type McpRenderPreviewMetadata = {
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
  /** 动画预览附加的实际身份（change: 2026-10-06-fix-model-media...）。 */
  animation?: {
    modelContentHash: string;
    motionSourceHash: string;
    motionScriptVersion: string;
    snapshotHash: string;
    timeSeconds: number;
    duration: number;
    loop: boolean;
    clipId?: string;
  };
};

export type McpRenderPreviewResult =
  | { ok: true; pngBase64: string; metadata: McpRenderPreviewMetadata; cached: boolean }
  | { ok: false; code: string; message: string };

export type McpApplyCommandsResult =
  | { ok: true; canvasId: string; commandId: string; duplicate: boolean; noop: boolean }
  | { ok: false; code: string; message: string };

export type McpMutateCamerasResult =
  | {
      ok: true;
      canvasId: string;
      nodeId: string;
      commandId: string;
      duplicate: boolean;
      noop: boolean;
      /** 提交后的规范化镜头集合。 */
      cameras: ModelCamera[];
    }
  | { ok: false; code: string; message: string };

export type McpMutateCamerasBatchResult =
  | {
      ok: true;
      canvasId: string;
      nodeId: string;
      commandId: string;
      duplicate: boolean;
      noop: boolean;
      /** 提交后的规范化镜头集合。 */
      cameras: ModelCamera[];
    }
  | { ok: false; code: string; message: string; failedIndex?: number };
