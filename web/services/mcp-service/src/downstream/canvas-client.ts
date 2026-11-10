/**
 * Canvas Service 内部协议 client（change: split-model-mcp-into-mcp-service）。
 *
 * MCP Service 的**唯一**画布访问通道：所有权限、校验与持久化都在 Canvas 侧；本 client
 * 只做版本化、受认证的 HTTP 调用与稳定错误映射。它不持有任何画布权威，也不 import
 * Canvas 实现（design D3）。
 */
import {
  decodeMcpApplyCommandsRequest,
  decodeMcpGetNodeRequest,
  decodeMcpGetModelNodesRequest,
  decodeMcpListNodesRequest,
  decodeMcpModelScriptBatchRequest,
  decodeMcpModelStatisticsRequest,
  decodeMcpRenderPreviewRequest,
  decodeMcpSubmitScriptRequest,
  MCP_INTERNAL_PATHS,
  MCP_INTERNAL_PROTOCOL_HEADER,
  MCP_INTERNAL_PROTOCOL_VERSION,
  MCP_INTERNAL_MAX_BODY_BYTES,
  SERVICE_TOKEN_HEADER,
  type CanvasCommand,
  type GetModelNodesInput,
  type McpApplyCommandsResult,
  type McpGetNodeResult,
  type McpListNodesResult,
  type McpModelStatisticsResult,
  type McpRenderPreviewResult,
  type McpSubmitScriptResult,
  type ModelNodesOutcome,
  type ModelScriptBatchOutcome,
  type ModelScriptBatchRequest,
  type SupportedModelScriptVersion
} from "@woohaa3/contracts";

export type CanvasMcpClientOptions = {
  baseUrl: string;
  serviceToken?: string;
  /** 单请求超时（毫秒）；默认 30s。预览可能较慢，可调高。 */
  timeoutMs?: number;
  logger?: (event: { event: string; status: number; code?: string }) => void;
  fetchImpl?: typeof fetch;
};

export type CanvasMcpClient = {
  /**
   * 批量模型能力（change: 2026-10-13-add-canvas-script-authoring / model-script-batch）。
   *
   * 可选：未接入时 `batch-tools` 明确返回「当前不可用」（fail closed），不回退逐节点拼装。
   * HTTP 通道走 `MCP_INTERNAL_PATHS.{getModelNodes,validateModelScripts,submitModelScripts}`。
   */
  getModelNodes?: (input: GetModelNodesInput) => Promise<ModelNodesOutcome>;
  validateScripts?: (input: ModelScriptBatchRequest) => Promise<ModelScriptBatchOutcome>;
  submitScripts?: (input: ModelScriptBatchRequest) => Promise<ModelScriptBatchOutcome>;

  listModelNodes(input: { canvasId?: string }): Promise<McpListNodesResult>;
  getModelNode(input: { canvasId: string; nodeId: string; includeStatistics?: boolean }): Promise<McpGetNodeResult>;
  /** 当前或候选脚本的模型规模（与聚焦信息面板同源）。 */
  getModelStatistics(input: { canvasId: string; nodeId: string; source?: string }): Promise<McpModelStatisticsResult>;
  submitScript(input: {
    canvasId: string;
    nodeId: string;
    source: string;
    version?: SupportedModelScriptVersion;
    /** model3d 编辑的稳定请求身份（change: 2026-10-06-fix-animation3d...，任务 5.1/5.2；2026-10-09 A09 改为必填）。 */
    requestId: string;
    /** model3d 编辑的模型内容 precondition。 */
    expectedModelContentHash?: string;
  }): Promise<McpSubmitScriptResult>;
  renderPreview(input: {
    canvasId: string;
    nodeId: string;
    width?: number;
    height?: number;
    background?: string;
    cameraPreset?: string;
    timeSeconds?: number;
    clipId?: string;
  }): Promise<McpRenderPreviewResult>;
  applyCommands(input: {
    canvasId: string;
    commandId: string;
    baseRevision: number;
    commands: CanvasCommand[];
  }): Promise<McpApplyCommandsResult>;
  /** readiness 探针：Canvas 内部面可达且协议兼容。 */
  ready(): Promise<{ ready: boolean; reason?: string }>;
};

export function createCanvasMcpClient(options: CanvasMcpClientOptions): CanvasMcpClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const log = options.logger ?? (() => undefined);

  async function call<T>(path: string, decoded: { ok: true; value: unknown } | { ok: false; code: string; message: string }): Promise<T> {
    if (!decoded.ok) {
      return { ok: false, code: decoded.code, message: decoded.message } as unknown as T;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [MCP_INTERNAL_PROTOCOL_HEADER]: String(MCP_INTERNAL_PROTOCOL_VERSION),
          ...(options.serviceToken ? { [SERVICE_TOKEN_HEADER]: options.serviceToken } : {})
        },
        body: JSON.stringify(decoded.value),
        signal: controller.signal
      });
      const text = await response.text();
      const body = text.trim() === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
      if (!response.ok) {
        log({ event: "canvas-mcp-client-error", status: response.status, code: String(body.code ?? "") });
        return {
          ok: false,
          code: typeof body.code === "string" ? body.code : "unavailable",
          message: typeof body.error === "string" ? body.error : `Canvas 返回 ${response.status}`
        } as unknown as T;
      }
      return body as T;
    } catch (error) {
      log({ event: "canvas-mcp-client-failure", status: 0, code: error instanceof Error ? error.name : "unknown" });
      return {
        ok: false,
        code: error instanceof Error && error.name === "AbortError" ? "timeout" : "unavailable",
        message: error instanceof Error ? error.message : "Canvas 内部协议调用失败"
      } as unknown as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async function probe(path: string): Promise<boolean> {
    try {
      const response = await doFetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [MCP_INTERNAL_PROTOCOL_HEADER]: String(MCP_INTERNAL_PROTOCOL_VERSION),
          ...(options.serviceToken ? { [SERVICE_TOKEN_HEADER]: options.serviceToken } : {})
        },
        body: "{}"
      });
      // 400/404 也说明协议面可达且协议头被接受；只有 401/409 代表配置错误。
      return response.status !== 401 && response.status !== 409;
    } catch {
      return false;
    }
  }

  return {
    listModelNodes: (input) => call<McpListNodesResult>(MCP_INTERNAL_PATHS.listNodes, decodeMcpListNodesRequest(input)),
    getModelNode: (input) => call<McpGetNodeResult>(MCP_INTERNAL_PATHS.getNode, decodeMcpGetNodeRequest(input)),
    getModelStatistics: (input) => call<McpModelStatisticsResult>(MCP_INTERNAL_PATHS.modelStatistics, decodeMcpModelStatisticsRequest(input)),
    submitScript: (input) => call<McpSubmitScriptResult>(MCP_INTERNAL_PATHS.submitScript, decodeMcpSubmitScriptRequest(input)),
    renderPreview: (input) => call<McpRenderPreviewResult>(MCP_INTERNAL_PATHS.renderPreview, decodeMcpRenderPreviewRequest(input)),
    applyCommands: (input) => call<McpApplyCommandsResult>(MCP_INTERNAL_PATHS.applyCommands, decodeMcpApplyCommandsRequest(input)),
    // 模型批量作者（model-script-batch）：与单节点脚本同一受认证内部面，actorId 由 Canvas 侧派生。
    getModelNodes: (input) => call<ModelNodesOutcome>(MCP_INTERNAL_PATHS.getModelNodes, decodeMcpGetModelNodesRequest(input)),
    validateScripts: (input) => call<ModelScriptBatchOutcome>(MCP_INTERNAL_PATHS.validateModelScripts, decodeMcpModelScriptBatchRequest(input)),
    submitScripts: (input) => call<ModelScriptBatchOutcome>(MCP_INTERNAL_PATHS.submitModelScripts, decodeMcpModelScriptBatchRequest(input)),
    async ready() {
      const reachable = await probe(MCP_INTERNAL_PATHS.listNodes);
      return reachable ? { ready: true } : { ready: false, reason: "Canvas 内部协议不可达或认证失败" };
    }
  };
}

/** 供测试/调试：内部协议请求体上限，与 Canvas 侧一致。 */
export const CANVAS_MCP_CLIENT_MAX_BODY_BYTES = MCP_INTERNAL_MAX_BODY_BYTES;
