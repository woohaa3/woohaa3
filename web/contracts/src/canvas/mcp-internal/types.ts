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
import type { FilmSetContent } from "../film-set-content.js";
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
  createFilmSetNode: `${MCP_INTERNAL_BASE_PATH}/film-set/create`,
  commitAnimation: `${MCP_INTERNAL_BASE_PATH}/animation/commit`,
  confirmAdaptation: `${MCP_INTERNAL_BASE_PATH}/animation/confirm-adaptation`,
  importModelSnapshot: `${MCP_INTERNAL_BASE_PATH}/animation/import-model`,
  importFilmSetContent: `${MCP_INTERNAL_BASE_PATH}/film-set/import-content`,
  mutateFilmSetItem: `${MCP_INTERNAL_BASE_PATH}/film-set/item`,
  /** 片场媒体条目受控导入（change: 2026-10-19-extend-film-set-for-motion-graphics，D5）。 */
  addFilmSetMedia: `${MCP_INTERNAL_BASE_PATH}/film-set/media`,
  /** agent 发起显式导出与查询（change 同上，D8）。 */
  exportFilmSetClip: `${MCP_INTERNAL_BASE_PATH}/film-set/export`,
  getFilmSetExport: `${MCP_INTERNAL_BASE_PATH}/film-set/export-status`,
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
  resource?: "group-appearance"; includeStatistics?: boolean;
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
  resource?: "group-appearance";
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
  /** 动画节点采样时刻（秒）；仅 animation3d 有效，缺省 0。 */
  timeSeconds?: number;
  clipId?: string;
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

/**
 * 创建动画节点请求（change: 2026-10-05-bind-model-animation-to-shots）。
 *
 * `model` 为完整模型源码与版本；`sourceNodeId` 为可选来源说明（复制快照，不建立运行依赖）。
 * `initialCamera` / `timeline` 可选，缺省时按模型 AABB 派生默认镜头、静态时间线。
 */
export type McpCreateFilmSetNodeRequest = {
  canvasId: string;
  nodeId: string;
  requestId: string;
  position?: { x: number; y: number };
  title?: string;
  model: {
    modelScript: string;
    modelScriptVersion: string;
    placement?: { offset: { x: number; y: number; z: number }; scale: number; yaw: number };
  };
  sourceNodeId?: string;
  motionScript?: string;
  timeline?: { duration: number; loop: boolean };
};

/**
 * 导入模型快照请求：替换片场内**指定 model item** 的模型定义，保留该对象的 binding 与旧适配版本
 * （change: 2026-10-11-extract-film-set-extension，D8/D10 —— items-only）。
 */
export type McpImportModelSnapshotRequest = {
  canvasId: string;
  nodeId: string;
  /** 目标 model item 稳定 ID（items-only 下片场无顶层模型）。 */
  itemId: string;
  requestId: string;
  modelScript: string;
  modelScriptVersion: string;
  placement?: { offset: { x: number; y: number; z: number }; scale: number; yaw: number };
  expectedSourceHash?: string;
};

/**
 * 复制导入片场内容请求
 * （change: 2026-10-08-make-film-set-model-only，任务 2.3 / design D4）。
 *
 * 每个来源项带前端生成的稳定对象 ID 与来源节点/资产身份。服务端在最新权威画布上解析
 * `model3d` 定义或 ready image/video asset，整批原子追加。文本、音频、片场和其他类型在
 * 结构校验阶段即拒绝（`kind` 只允许三种），不在服务端静默跳过。
 */
export type McpFilmSetImportItem =
  | {
      kind: "model";
      itemId: string;
      name: string;
      sourceNodeId: string;
      expectedSourceHash?: string;
    }
  | {
      kind: "image" | "video";
      itemId: string;
      name: string;
      sourceNodeId: string;
      assetId: string;
      aspectRatio: number;
      /** 视频时长（秒）；用于扩展片场时间线（change: 2026-10-08-make-film-set-model-only）。 */
      durationSeconds?: number;
      expectedChecksum?: string;
    };

export type McpImportFilmSetContentRequest = {
  canvasId: string;
  nodeId: string;
  requestId: string;
  items: McpFilmSetImportItem[];
};

/**
 * 完整动画定义提交请求
 * （change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 4.3）。
 *
 * 生成层提交**完整本地定义**（模型 + 独立运动 + 初始镜头 + 时间线），经 `commitAnimation`
 * 在权威串行边界带 `expectedSnapshotHash` 原子提交；不创建替代节点，不修改来源。
 */
export type McpCommitAnimationRequest = {
  canvasId: string;
  nodeId: string;
  requestId: string;
  animation: unknown;
  expectedSnapshotHash?: string;
  clipId?: string;
  expectedClipHash?: string;
  title?: string;
};

/** 确认运动适配当前模型版本请求（items-only：定位到 clip + item binding，D10）。 */
export type McpConfirmAdaptationRequest = {
  canvasId: string;
  nodeId: string;
  clipId: string;
  itemId: string;
  expectedAdapterHash: string;
  requestId: string;
  expectedSnapshotHash?: string;
};

/**
 * 片场对象级权威变更请求
 * （change: 2026-10-09-add-film-set-object-motion-and-editing，任务 2.3/6.1 / design D6）。
 *
 * 固定 `nodeId` / `itemId`，`op` 描述一次 transform/delete/model/motion/playback/confirm-adaptation。
 * Canvas 侧从最新权威集合读取对应 item 并原子更新；MCP 不按数组序号定位。
 */
export type McpMutateFilmSetItemRequest = {
  canvasId: string;
  nodeId: string;
  itemId: string;
  requestId: string;
  op: import("../film-set-content/command-types.js").FilmSetItemPatchOp;
};

/**
 * 片场媒体条目受控导入请求
 * （change: 2026-10-19-extend-film-set-for-motion-graphics，D5）。
 *
 * 来源必须是同一画布内 ready 的图片或视频节点；服务端从权威画布解析 `assetId`、固有宽高比与
 * 视频时长，调用方只给来源节点与可选摆放；`expectedContentHash` 为片场内容 precondition。
 */
export type McpAddFilmSetMediaRequest = {
  canvasId: string;
  nodeId: string;
  requestId: string;
  sourceNodeId: string;
  /** 片场内容身份 precondition（`filmSetContentHash`）；不一致时拒绝。 */
  expectedContentHash?: string;
  /** 新条目 id（省略时由服务端按 requestId 派生稳定 id）。 */
  itemId?: string;
  /** 条目名（省略时用来源节点标题或种类名）。 */
  name?: string;
  /** 可选基础局部变换；缺省按导入布局错开。 */
  transform?: import("../film-set-content.js").FilmSetLocalTransform;
};

/** 媒体导入结果。 */
export type McpAddFilmSetMediaOutcome =
  | {
      ok: true;
      canvasId: string;
      nodeId: string;
      itemId: string;
      itemKind: "image" | "video";
      commandId: string;
      duplicate: boolean;
      noop: boolean;
      contentHash: string;
      itemCount: number;
    }
  | { ok: false; code: string; message: string };

/**
 * agent 发起显式导出的请求（D8）。
 *
 * 只携带稳定身份、profile 与内容 precondition；像素与播放状态一概不传，任务由本机宿主原生
 * 录制完成。
 */
export type McpExportFilmSetClipRequest = {
  canvasId: string;
  nodeId: string;
  clipId: string;
  requestId: string;
  profile: import("../film-set-export-profile.js").FilmSetExportProfile;
  /** 片场内容身份 precondition（`filmSetContentHash`）；不一致时拒绝。 */
  expectedContentHash?: string;
};

/** 导出提交结果：`jobId` 用于后续轮询（按 requestId 幂等）。 */
export type McpExportFilmSetClipOutcome =
  | { ok: true; canvasId: string; nodeId: string; clipId: string; jobId: string; state: string; duplicate: boolean }
  | { ok: false; code: string; message: string };

/** 查询导出任务。 */
export type McpGetFilmSetExportRequest = {
  canvasId: string;
  jobId: string;
};

/** 导出任务状态（成功时带节点与资产身份）。 */
export type McpGetFilmSetExportOutcome =
  | {
      ok: true;
      canvasId: string;
      jobId: string;
      state: string;
      completedFrames: number;
      totalFrames: number;
      progress?: number;
      nodeId?: string;
      assetId?: string;
      error?: { code: string; message: string; stage?: string };
    }
  | { ok: false; code: string; message: string };

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
      resource?: "group-appearance";
      appearanceSource?: "default" | "custom" | "unsupported";
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
      /**
       * 自包含动画节点的**自身**完整定义
       * （change: 2026-10-05-bind-model-animation-to-shots，任务 4.5）；普通模型节点省略。
       */
      animation?: {
        title?: string;
        scenePlacement?: import("../film-set-content.js").FilmSetLocalTransform;
        sceneCamera?: import("../canvas-node-model.js").InitialShotCamera;
        origin?: import("../canvas-node-model.js").ModelImportOrigin;
        motionScript: string;
        motionScriptLanguage: string;
        motionScriptVersion: string;
        motionRevision: number;
        motionSourceHash: string;
        modelContentVersion: { revision: number; sourceHash: string; contentHash: string };
        motionBasedOnModelVersion: { revision: number; contentHash: string };
        initialCamera: {
          azimuth: number;
          elevation: number;
          distance: number;
          aspect: string;
          focusOffset: { x: number; y: number; z: number };
        };
        timeline: { duration: number; loop: boolean };
        /**
         * 片场内部内容集合（change: 2026-10-08-make-film-set-model-only）。
         * 普通模型节点省略；旧片场缺失时为空集合。
         */
        filmSetContent: FilmSetContent;
        filmSetAnimations?: import("../film-set-animations.js").FilmSetAnimations;
      };
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
