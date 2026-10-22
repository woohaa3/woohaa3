/**
 * Model MCP 内部协议 HTTP 面（change: split-model-mcp-into-mcp-service）。
 *
 * 受认证的服务间入口，供独立运行单元 `mcp-service` 读写画布模型能力。它复用
 * `ModelMcpService`（权威读取、脚本提交、预览）与通用语义命令提交，**不**新增命令类型。
 *
 * 安全边界（spec「受认证的内部语义命令入口」）：
 * - 必须携带受支持的内部协议版本头，否则在副作用前返回 `protocol-incompatible`；
 * - 必须通过服务身份令牌（未配置令牌时只允许 loopback）；
 * - `actorId` 由**服务身份派生**（`MCP_INTERNAL_ACTOR_ID`），绝不从请求体读取。
 *
 * 路径位于 `/internal/v1/*`，公网 ingress 一律拒绝。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  decodeMcpApplyCommandsRequest,
  decodeMcpCommitAnimationRequest,
  decodeMcpConfirmAdaptationRequest,
  decodeMcpCreateFilmSetNodeRequest,
  decodeMcpGetNodeRequest,
  decodeMcpGetModelNodesRequest,
  decodeMcpImportFilmSetContentRequest,
  decodeMcpImportModelSnapshotRequest,
  decodeMcpListNodesRequest,
  decodeMcpModelScriptBatchRequest,
  decodeMcpModelStatisticsRequest,
  decodeMcpMutateCamerasBatchRequest,
  decodeMcpMutateCamerasRequest,
  decodeMcpMutateFilmSetItemRequest,
  decodeMcpRenderPreviewRequest,
  decodeMcpReportScriptRequest,
  decodeMcpSubmitScriptRequest,
  MCP_INTERNAL_BASE_PATH,
  MCP_INTERNAL_MAX_BODY_BYTES,
  MCP_INTERNAL_PATHS,
  MCP_INTERNAL_PROTOCOL_HEADER,
  MCP_INTERNAL_PROTOCOL_VERSION,
  MCP_INTERNAL_ACTOR_ID
} from "@woohaa3/contracts";
import type {
  ApplyCommandsInput,
  ApplyCommandsOutcome,
  GetModelNodeInput,
  GetModelNodeOutcome,
  ListModelNodesOutcome,
  MutateCamerasBatchInput,
  MutateCamerasBatchOutcome,
  MutateCamerasInput,
  MutateCamerasOutcome,
  RenderPreviewInput,
  RenderPreviewOutcome,
  ReportScriptOutcome,
  ModelStatisticsInput,
  ModelStatisticsOutcome,
  SubmitScriptInput,
  SubmitScriptOutcome
} from "./service.js";
import type { SupportedModelScriptVersion } from "@woohaa3/contracts";
import type {
  GetModelNodesInput,
  ModelNodesOutcome,
  ModelScriptBatchOutcome,
  ModelScriptBatchRequest
} from "@woohaa3/contracts";
import type { ModelBatchContext } from "./batch-service.js";
import type {
  McpCommitAnimationRequest,
  McpConfirmAdaptationRequest,
  McpCreateFilmSetNodeRequest,
  McpImportModelSnapshotRequest,
  McpImportFilmSetContentRequest,
  McpMutateFilmSetItemRequest
} from "@woohaa3/contracts";
import type { FilmSetNodeOutcome, MutateFilmSetItemOutcome } from "@woohaa3/contracts";

export type CreateFilmSetNodeOutcome =
  | { ok: true; canvasId: string; nodeId: string; commandId: string; duplicate: boolean; noop: boolean }
  | { ok: false; code: string; message: string };

/** 片场内容导入结果（change: 2026-10-08-make-film-set-model-only，任务 2.3）。 */
export type ImportFilmSetContentOutcome =
  | {
      ok: true;
      canvasId: string;
      nodeId: string;
      commandId: string;
      duplicate: boolean;
      noop: boolean;
      contentHash: string;
      itemCount: number;
    }
  | { ok: false; code: string; message: string };

export type { MutateFilmSetItemOutcome };

/** handler 只依赖这份能力；`ModelMcpService` 结构上满足它。 */
export type ModelMcpInternalService = {
  listModelNodes: (input: { canvasId?: string }) => Promise<ListModelNodesOutcome>;
  getModelNode: (input: GetModelNodeInput) => Promise<GetModelNodeOutcome>;
  /** 当前或候选脚本的规模统计（与聚焦信息面板同源）；省略时 statistics 路由返回 503。 */
  getModelStatistics?: (input: ModelStatisticsInput) => Promise<ModelStatisticsOutcome>;
  submitScript: (input: SubmitScriptInput) => Promise<SubmitScriptOutcome>;
  reportScript?: (input: {
    canvasId: string;
    nodeId: string;
    status: "ok" | "failed";
    message?: string;
  }) => Promise<ReportScriptOutcome>;
  renderPreview?: (input: RenderPreviewInput) => Promise<RenderPreviewOutcome>;
  applyCommands?: (input: ApplyCommandsInput) => Promise<ApplyCommandsOutcome>;
  /** 单条镜头读改写；省略时 mutateCameras 路由返回 503。 */
  mutateCameras?: (input: MutateCamerasInput) => Promise<MutateCamerasOutcome>;
  /** 批量镜头读改写（整批原子）；省略时 mutateCamerasBatch 路由返回 503。 */
  mutateCamerasBatch?: (input: MutateCamerasBatchInput) => Promise<MutateCamerasBatchOutcome>;
  /** 批量模型读取（model-script-batch）；省略时相应路由返回 503。 */
  getModelNodes?: (input: GetModelNodesInput) => Promise<ModelNodesOutcome>;
  /** 模型脚本批量只校验（model-script-batch）；省略时相应路由返回 503。 */
  validateScripts?: (input: ModelScriptBatchRequest, context: ModelBatchContext) => Promise<ModelScriptBatchOutcome>;
  /** 模型脚本批量校验并提交（model-script-batch）；省略时相应路由返回 503。 */
  submitScripts?: (input: ModelScriptBatchRequest, context: ModelBatchContext) => Promise<ModelScriptBatchOutcome>;
  /** 创建动画节点（复制模型快照）；省略时相应路由返回 503。 */
  createFilmSetNode?: (input: McpCreateFilmSetNodeRequest & { canvasId: string }) => Promise<CreateFilmSetNodeOutcome>;
  /** 导入模型快照（保留运动与旧适配版本）；省略时相应路由返回 503。 */
  importModelSnapshot?: (input: McpImportModelSnapshotRequest & { canvasId: string }) => Promise<CreateFilmSetNodeOutcome>;
  /** 复制导入片场内容；省略时相应路由返回 503。 */
  importFilmSetContent?: (input: McpImportFilmSetContentRequest & { canvasId: string }) => Promise<ImportFilmSetContentOutcome>;
  /** 完整动画定义提交；省略时 commitAnimation 路由返回 503。 */
  commitAnimation?: (input: McpCommitAnimationRequest & { canvasId: string; nodeId: string; requestId: string }) => Promise<FilmSetNodeOutcome>;
  /** 确认运动适配当前模型版本；省略时 confirmAdaptation 路由返回 503。 */
  confirmAdaptation?: (input: McpConfirmAdaptationRequest & { canvasId: string; nodeId: string; requestId: string }) => Promise<FilmSetNodeOutcome>;
  /** 片场对象级权威变更；省略时相应路由返回 503。 */
  mutateFilmSetItem?: (input: McpMutateFilmSetItemRequest & { canvasId: string }) => Promise<MutateFilmSetItemOutcome>;
};

export type ModelMcpInternalHandlerOptions = {
  /** 权威模型能力；省略时相应路由返回 503。 */
  service?: ModelMcpInternalService;
  /** 服务身份令牌；未配置时只允许 loopback。 */
  serviceToken?: string;
  maxBodyBytes?: number;
  logger?: (event: { event: string; status: number; code?: string }) => void;
};

export type ModelMcpInternalHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function createModelMcpInternalHandler(
  options: ModelMcpInternalHandlerOptions
): ModelMcpInternalHandler {
  const maxBodyBytes = options.maxBodyBytes ?? MCP_INTERNAL_MAX_BODY_BYTES;
  const log = options.logger ?? (() => undefined);

  return async (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return false;
    }
    if (!pathname.startsWith(`${MCP_INTERNAL_BASE_PATH}/`) && pathname !== MCP_INTERNAL_BASE_PATH) return false;
    if (pathname !== MCP_INTERNAL_PATHS.listNodes
      && pathname !== MCP_INTERNAL_PATHS.getNode
      && pathname !== MCP_INTERNAL_PATHS.submitScript
      && pathname !== MCP_INTERNAL_PATHS.reportScript
      && pathname !== MCP_INTERNAL_PATHS.renderPreview
      && pathname !== MCP_INTERNAL_PATHS.applyCommands
      && pathname !== MCP_INTERNAL_PATHS.mutateCameras
      && pathname !== MCP_INTERNAL_PATHS.mutateCamerasBatch
      && pathname !== MCP_INTERNAL_PATHS.getModelNodes
      && pathname !== MCP_INTERNAL_PATHS.validateModelScripts
      && pathname !== MCP_INTERNAL_PATHS.submitModelScripts
      && pathname !== MCP_INTERNAL_PATHS.createFilmSetNode
      && pathname !== MCP_INTERNAL_PATHS.commitAnimation
      && pathname !== MCP_INTERNAL_PATHS.confirmAdaptation
      && pathname !== MCP_INTERNAL_PATHS.importModelSnapshot
      && pathname !== MCP_INTERNAL_PATHS.importFilmSetContent
      && pathname !== MCP_INTERNAL_PATHS.mutateFilmSetItem
      && pathname !== MCP_INTERNAL_PATHS.modelStatistics) {
      sendJson(res, 404, { error: "not-found" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return true;
    }

    // 认证与协议版本都在读 body / 触达 service 之前校验。
    const tokenError = checkServiceToken(req, options.serviceToken);
    if (tokenError) {
      log({ event: "model-mcp-internal-token-rejected", status: 401 });
      sendJson(res, 401, { error: "unauthorized", code: "unauthorized" });
      return true;
    }
    const declared = readHeader(req, MCP_INTERNAL_PROTOCOL_HEADER);
    if (Number(declared) !== MCP_INTERNAL_PROTOCOL_VERSION) {
      log({ event: "model-mcp-internal-protocol-rejected", status: 409 });
      sendJson(res, 409, {
        error: "protocol-incompatible",
        code: "protocol-incompatible",
        protocolVersion: MCP_INTERNAL_PROTOCOL_VERSION
      });
      return true;
    }

    const body = await readJson(req, maxBodyBytes).catch(() => null);
    if (body === null) {
      sendJson(res, 400, { error: "malformed-request", code: "malformed-request" });
      return true;
    }

    if (pathname === MCP_INTERNAL_PATHS.listNodes) {
      const decoded = decodeMcpListNodesRequest(body);
      if (!decoded.ok) return badRequest(res, decoded.code, decoded.message);
      if (!options.service) return unavailable(res, "模型 MCP 当前不可用");
      const outcome = await options.service.listModelNodes({ canvasId: decoded.value.canvasId });
      return sendOutcome(res, outcome, log);
    }

    if (pathname === MCP_INTERNAL_PATHS.getNode) {
      const decoded = decodeMcpGetNodeRequest(body);
      if (!decoded.ok) return badRequest(res, decoded.code, decoded.message);
      if (!options.service) return unavailable(res, "模型 MCP 当前不可用");
      const outcome = await options.service.getModelNode({
        canvasId: decoded.value.canvasId,
        nodeId: decoded.value.nodeId,
        ...(decoded.value.includeStatistics === true ? { includeStatistics: true } : {})
      });
      return sendOutcome(res, outcome, log);
    }

    if (pathname === MCP_INTERNAL_PATHS.modelStatistics) {
      const decoded = decodeMcpModelStatisticsRequest(body);
      if (!decoded.ok) return badRequest(res, decoded.code, decoded.message);
      if (!options.service?.getModelStatistics) return unavailable(res, "模型统计当前不可用");
      const outcome = await options.service.getModelStatistics({
        canvasId: decoded.value.canvasId,
        nodeId: decoded.value.nodeId,
        ...(decoded.value.source === undefined ? {} : { source: decoded.value.source })
      });
      return sendOutcome(res, outcome, log);
    }

    if (pathname === MCP_INTERNAL_PATHS.submitScript) {
      const decoded = decodeMcpSubmitScriptRequest(body);
      if (!decoded.ok) return badRequest(res, decoded.code, decoded.message);
      if (!options.service) return unavailable(res, "模型 MCP 当前不可用");
      const outcome = await options.service.submitScript({
        canvasId: decoded.value.canvasId,
        nodeId: decoded.value.nodeId,
        source: decoded.value.source,
        requestId: decoded.value.requestId ?? "",
        ...(decoded.value.version ? { version: decoded.value.version as SupportedModelScriptVersion } : {}),
        ...(decoded.value.expectedModelContentHash === undefined
          ? {}
          : { expectedModelContentHash: decoded.value.expectedModelContentHash })
      });
      return sendOutcome(res, outcome, log);
    }

    if (pathname === MCP_INTERNAL_PATHS.reportScript) {
      const decoded = decodeMcpReportScriptRequest(body);
      if (!decoded.ok) return badRequest(res, decoded.code, decoded.message);
      if (!options.service?.reportScript) return unavailable(res, "模型 MCP 当前不可用");
      const outcome = await options.service.reportScript({
        canvasId: decoded.value.canvasId,
        nodeId: decoded.value.nodeId,
        status: decoded.value.status,
        ...(decoded.value.message === undefined ? {} : { message: decoded.value.message })
      });
      return sendOutcome(res, outcome, log);
    }

    if (pathname === MCP_INTERNAL_PATHS.renderPreview) {
      const decoded = decodeMcpRenderPreviewRequest(body);
      if (!decoded.ok) return badRequest(res, decoded.code, decoded.message);
      if (!options.service?.renderPreview) return unavailable(res, "模型预览当前不可用", "renderer-unavailable");
      const outcome = await options.service.renderPreview({
        canvasId: decoded.value.canvasId,
        nodeId: decoded.value.nodeId,
        ...(decoded.value.width !== undefined ? { width: decoded.value.width } : {}),
        ...(decoded.value.height !== undefined ? { height: decoded.value.height } : {}),
        ...(decoded.value.background !== undefined ? { background: decoded.value.background } : {}),
        ...(decoded.value.cameraPreset !== undefined ? { cameraPreset: decoded.value.cameraPreset } : {}),
        ...(decoded.value.timeSeconds !== undefined ? { timeSeconds: decoded.value.timeSeconds } : {}),
        ...(decoded.value.clipId ? { clipId: decoded.value.clipId } : {})
      });
      return sendOutcome(res, outcome, log);
    }

    // 模型批量作者（model-script-batch）：批量读取、只校验、校验并提交。
    // actorId 与单节点路径同一来源（`MCP_INTERNAL_ACTOR_ID`），不从请求体读取。
    if (pathname === MCP_INTERNAL_PATHS.getModelNodes) {
      const decoded = decodeMcpGetModelNodesRequest(body);
      if (!decoded.ok) return badRequest(res, decoded.code, decoded.message);
      if (!options.service?.getModelNodes) return unavailable(res, "批量模型读取当前不可用");
      const outcome = await options.service.getModelNodes(decoded.value);
      return sendOutcome(res, outcome, log);
    }

    if (pathname === MCP_INTERNAL_PATHS.validateModelScripts || pathname === MCP_INTERNAL_PATHS.submitModelScripts) {
      const decoded = decodeMcpModelScriptBatchRequest(body);
      if (!decoded.ok) return badRequest(res, decoded.code, decoded.message);
      const validateOnly = pathname === MCP_INTERNAL_PATHS.validateModelScripts;
      const batch = validateOnly ? options.service?.validateScripts : options.service?.submitScripts;
      if (!batch) return unavailable(res, "批量模型脚本当前不可用");
      const context: ModelBatchContext = { principalId: MCP_INTERNAL_ACTOR_ID };
      const outcome = await batch(decoded.value, context);
      return sendOutcome(res, outcome, log);
    }

    // mutateCameras（单条镜头读改写）
    if (pathname === MCP_INTERNAL_PATHS.mutateCameras) {
      const decoded = decodeMcpMutateCamerasRequest(body);
      if (!decoded.ok) return badRequest(res, decoded.code, decoded.message);
      if (!options.service?.mutateCameras) return unavailable(res, "模型 MCP 当前不可用");
      const outcome = await options.service.mutateCameras({
        canvasId: decoded.value.canvasId,
        nodeId: decoded.value.nodeId,
        requestId: decoded.value.requestId,
        mutation: decoded.value.mutation
      });
      return sendOutcome(res, outcome, log);
    }

    // mutateCamerasBatch（批量镜头读改写；整批原子）
    if (pathname === MCP_INTERNAL_PATHS.mutateCamerasBatch) {
      const decoded = decodeMcpMutateCamerasBatchRequest(body);
      if (!decoded.ok) return badRequest(res, decoded.code, decoded.message);
      if (!options.service?.mutateCamerasBatch) return unavailable(res, "模型 MCP 当前不可用");
      const outcome = await options.service.mutateCamerasBatch({
        canvasId: decoded.value.canvasId,
        nodeId: decoded.value.nodeId,
        requestId: decoded.value.requestId,
        mutations: decoded.value.mutations
      });
      return sendOutcome(res, outcome, log);
    }

    // 创建动画节点（复制模型快照）
    if (pathname === MCP_INTERNAL_PATHS.createFilmSetNode) {
      const decoded = decodeMcpCreateFilmSetNodeRequest(body);
      if (!decoded.ok) return badRequest(res, decoded.code, decoded.message);
      if (!options.service?.createFilmSetNode) return unavailable(res, "片场能力当前不可用");
      const outcome = await options.service.createFilmSetNode({
        ...decoded.value,
        canvasId: decoded.value.canvasId,
        position: decoded.value.position ?? { x: 0, y: 0 }
      });
      return sendOutcome(res, outcome, log);
    }

    // 完整动画定义提交（模型 + 运动 + 初始镜头 + 时间线）
    if (pathname === MCP_INTERNAL_PATHS.commitAnimation) {
      const decoded = decodeMcpCommitAnimationRequest(body);
      if (!decoded.ok) return badRequest(res, decoded.code, decoded.message);
      if (!options.service?.commitAnimation) return unavailable(res, "片场能力当前不可用");
      const outcome = await options.service.commitAnimation({
        ...decoded.value,
        canvasId: decoded.value.canvasId,
        nodeId: decoded.value.nodeId,
        requestId: decoded.value.requestId
      });
      return sendOutcome(res, outcome, log);
    }

    // 确认运动适配当前模型版本
    if (pathname === MCP_INTERNAL_PATHS.confirmAdaptation) {
      const decoded = decodeMcpConfirmAdaptationRequest(body);
      if (!decoded.ok) return badRequest(res, decoded.code, decoded.message);
      if (!options.service?.confirmAdaptation) return unavailable(res, "片场能力当前不可用");
      const outcome = await options.service.confirmAdaptation({
        ...decoded.value,
        canvasId: decoded.value.canvasId,
        nodeId: decoded.value.nodeId,
        requestId: decoded.value.requestId
      });
      return sendOutcome(res, outcome, log);
    }

    // 导入模型快照（保留运动与旧适配版本）
    if (pathname === MCP_INTERNAL_PATHS.importModelSnapshot) {
      const decoded = decodeMcpImportModelSnapshotRequest(body);
      if (!decoded.ok) return badRequest(res, decoded.code, decoded.message);
      if (!options.service?.importModelSnapshot) return unavailable(res, "片场能力当前不可用");
      const outcome = await options.service.importModelSnapshot({
        ...decoded.value,
        canvasId: decoded.value.canvasId
      });
      return sendOutcome(res, outcome, log);
    }

    // 复制导入片场内容（change: 2026-10-08-make-film-set-model-only）
    if (pathname === MCP_INTERNAL_PATHS.importFilmSetContent) {
      const decoded = decodeMcpImportFilmSetContentRequest(body);
      if (!decoded.ok) return badRequest(res, decoded.code, decoded.message);
      if (!options.service?.importFilmSetContent) return unavailable(res, "片场导入能力当前不可用");
      const outcome = await options.service.importFilmSetContent({
        ...decoded.value,
        canvasId: decoded.value.canvasId
      });
      return sendOutcome(res, outcome, log);
    }

    // 片场对象级权威变更（change: 2026-10-09-add-film-set-object-motion-and-editing）
    if (pathname === MCP_INTERNAL_PATHS.mutateFilmSetItem) {
      const decoded = decodeMcpMutateFilmSetItemRequest(body);
      if (!decoded.ok) return badRequest(res, decoded.code, decoded.message);
      if (!options.service?.mutateFilmSetItem) return unavailable(res, "片场对象能力当前不可用");
      const outcome = await options.service.mutateFilmSetItem({
        ...decoded.value,
        canvasId: decoded.value.canvasId
      });
      return sendOutcome(res, outcome, log);
    }

    // applyCommands
    const decoded = decodeMcpApplyCommandsRequest(body);
    if (!decoded.ok) return badRequest(res, decoded.code, decoded.message);
    if (!options.service?.applyCommands) return unavailable(res, "模型 MCP 当前不可用");
    const outcome = await options.service.applyCommands({
      canvasId: decoded.value.canvasId,
      commandId: decoded.value.commandId,
      baseRevision: decoded.value.baseRevision,
      commands: decoded.value.commands
    });
    return sendOutcome(res, outcome, log);
  };
}

/** 内部协议写入使用的稳定 actorId（由服务身份派生）。 */
export const MODEL_MCP_INTERNAL_ACTOR_ID = MCP_INTERNAL_ACTOR_ID;

function sendOutcome(
  res: ServerResponse,
  outcome: { ok: boolean } & Record<string, unknown>,
  log: (event: { event: string; status: number; code?: string }) => void
): true {
  if (outcome.ok) {
    sendJson(res, 200, outcome);
    return true;
  }
  const code = typeof outcome.code === "string" ? outcome.code : "unavailable";
  const status = statusForCode(code);
  log({ event: "model-mcp-internal-rejected", status, code });
  sendJson(res, status, outcome);
  return true;
}

function statusForCode(code: string): number {
  switch (code) {
    case "canvas-not-found":
    case "unknown-node":
    case "unknown-camera":
      return 404;
    case "source-hash-conflict":
      return 409;
    case "render-busy":
      return 429;
    case "renderer-unavailable":
      return 503;
    case "canvas-unavailable":
      return 503;
    default:
      return 400;
  }
}

function badRequest(res: ServerResponse, code: string, message: string): true {
  sendJson(res, 400, { error: message, code });
  return true;
}

function unavailable(res: ServerResponse, message: string, code = "unavailable"): true {
  sendJson(res, 503, { error: message, code });
  return true;
}

function checkServiceToken(req: IncomingMessage, expected: string | undefined): string | null {
  if (!expected) {
    return isLoopbackRequest(req) ? null : "缺少服务令牌且请求不是本机";
  }
  return readHeader(req, "x-woohaa3-service-token") === expected ? null : "缺少或无效的服务令牌";
}

function readHeader(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers[name];
  return Array.isArray(header) ? header[0] : header;
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress ?? "";
  if (address === "::1" || address === "127.0.0.1") return true;
  if (address.startsWith("127.")) return true;
  if (address.startsWith("::ffff:127.")) return true;
  return false;
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > maxBytes) throw new Error("请求体超过上限");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  return JSON.parse(text) as unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(Buffer.byteLength(payload)));
  res.end(payload);
}
