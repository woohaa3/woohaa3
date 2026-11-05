/**
 * Canvas Remote adapter（change: adopt-frontend-cordis-plugin-runtime，design D4）。
 *
 * **唯一**浏览器 Canvas Service 协议出口：Yjs sync socket、run/cancel、
 * Model MCP script report。feature/plugin 只依赖 `CanvasRemoteService` contract。
 *
 * adapter 构造时固定 `canvasId`（首阶段只维护一个画布），与既有
 * `createCanvasRunClient({ canvasId })` 语义一致。
 *
 * 本地单实例不启用访问控制；受控部署由同源会话身份与画布资源策略判定。
 */
import {
  SESSION_CHANNEL,
  decodeTaskActivityServerMessage,
  encodeTaskActivitySubscribe
} from "@woohaa3/contracts/canvas-yjs";
import {
  decodeWorldAuthoringFailure,
  decodeWorldAuthoringResponse,
  type WorldAuthoringResponseRoute
} from "@woohaa3/contracts";
import { getAppPublicFetch, appPublicUrl } from "./app-base-path.js";
import type { CanvasSessionTransport } from "./canvas-session-transport.js";
import { canvasSessionUrl, createCanvasSessionTransport } from "./canvas-session-transport.js";
import type {
  CanvasCancelResult,
  CanvasRemoteService,
  CanvasRunRequest,
  CanvasRunResult,
  EditCompleteResult,
  ModelScriptReport,
  NodeHistoryResult,
  SnippetResult
} from "../contracts.js";
import type {
  CanvasCaptureFreezeResult,
  PageCapturePendingEntry,
  PageCapturePendingResult,
  WorldCaptureStatusResult
} from "../contract/remote.js";
import type {
  CreatePromptSnippetInput,
  CreatePromptSnippetTagInput,
  CanvasGenerationHistoryListPage,
  ImageProjectReferencesResult,
  CanvasTaskActivityEventBatch,
  CanvasTaskActivitySnapshot,
  EditSessionBeginResponse,
  EditSessionCompletionReceipt,
  MergeNodeHistoryReceipt,
  NodeGenerationHistoryDetail,
  NodeGenerationHistoryListPage,
  PromptSnippet,
  PromptSnippetErrorCode,
  PromptSnippetListQuery,
  PromptSnippetListResult,
  PromptSnippetTag,
  RenamePromptSnippetTagInput,
  UpdatePromptSnippetInput
} from "@woohaa3/contracts";
import {
  CANVAS_API_BASE_PATH,
  MODEL_MCP_REPORT_PATH,
  NODE_HISTORY_BASE_PATH,
  PROMPT_SNIPPETS_BASE_PATH,
  TASK_ACTIVITY_BASE_PATH,
  nodeHistoryUrlFor
} from "./paths.js";

export type CanvasRemoteOptions = {
  canvasId: string;
  basePath?: string;
  reportPath?: string;
  /** 片段目录 base path；测试可注入。 */
  snippetBasePath?: string;
  /** 节点历史 base path；测试可注入。 */
  nodeHistoryBasePath?: string;
  /** 画布任务活动 base path；测试可注入。 */
  taskActivityBasePath?: string;
  /**
   * 页面内世界镜头捕获渲染器（页面渲染路径）。缺省时 `freezeWorldCapture` 直接失败，
   * 不回退原生 renderer。
   */
  renderWorldCapture?: (input: {
    cameraId: string;
    width: number;
    height: number;
  }) => Promise<{ ok: true; png: Uint8Array } | { ok: false; code: string }>;
  fetchImpl?: typeof globalThis.fetch;
  /** WebSocket 构造器；测试可注入 fake。 */
  webSocketImpl?: typeof globalThis.WebSocket;
  /** 页面 location；测试可注入。 */
  location?: { protocol?: string; host?: string };
  /** 传输重连退避参数（测试用同步驱动）。 */
  transport?: {
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
    jitterRatio?: number;
    schedule?: (run: () => void, delayMs: number) => () => void;
    random?: () => number;
  };
};

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Uint8Array → base64（分块避免参数上限）；无 DOM 时用 Buffer 兜底。 */
function bytesToBase64(bytes: Uint8Array): string {
  const bufferCtor = (globalThis as { Buffer?: { from(input: Uint8Array): { toString(encoding: string): string } } }).Buffer;
  if (bufferCtor) return bufferCtor.from(bytes).toString("base64");
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** 把页面渲染的 PNG 提交给宿主校验、保存并冻结；返回 binding 或稳定错误。 */
async function postPageCommit(
  captureBase: string,
  fetchImpl: typeof globalThis.fetch,
  input: { cameraId: string; key: unknown; png: Uint8Array; width: number; height: number; signal?: AbortSignal }
): Promise<CanvasCaptureFreezeResult> {
  let committed: Response;
  try {
    committed = await fetchImpl(`${captureBase}-page-commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cameraId: input.cameraId,
        key: input.key,
        pngBase64: bytesToBase64(input.png),
        width: input.width,
        height: input.height
      }),
      ...(input.signal ? { signal: input.signal } : {})
    });
  } catch {
    return { ok: false, code: "capture-unavailable", error: "无法连接取景服务" };
  }
  const committedBody = (await committed.json().catch(() => null)) as Record<string, unknown> | null;
  if (committedBody && committedBody.ok === true && committedBody.binding && typeof committedBody.binding === "object") {
    return {
      ok: true,
      binding: committedBody.binding as import("@woohaa3/contracts").WorldCaptureGenerationBinding
    };
  }
  return {
    ok: false,
    code: typeof committedBody?.code === "string" ? committedBody.code : `http-${committed.status}`,
    error: typeof committedBody?.message === "string" && committedBody.message !== ""
      ? committedBody.message
      : `取景冻结失败（HTTP ${committed.status}）`,
    ...(committedBody?.requestedKey ? { requestedKey: committedBody.requestedKey as import("@woohaa3/contracts").WorldCaptureVersionKey } : {}),
    ...(committedBody?.currentKey ? { currentKey: committedBody.currentKey as import("@woohaa3/contracts").WorldCaptureVersionKey } : {})
  };
}

function decodeWorldResponse(response: Response, value: unknown, route: WorldAuthoringResponseRoute): unknown {
  if (!record(value)) throw new Error("invalid response");
  const result = value;
  if (!response.ok && result.ok === undefined && typeof result.code === "string" && typeof result.message === "string") {
    const codes: Record<string, string> = {
      DELETED: "not-found", PREPARATION_REQUIRED: "not-ready", NOT_READY: "not-ready",
      FORBIDDEN: "write-forbidden", UNAUTHORIZED: "write-forbidden", INVALID_COMMAND_BATCH: "invalid-data"
    };
    return { ok: false, code: codes[result.code] ?? (response.status === 401 || response.status === 403 ? "write-forbidden" : "not-ready"), message: result.message, transportCode: result.code };
  }
  if (result.ok === false) {
    const failure = decodeWorldAuthoringFailure(result);
    if (!failure.ok) throw new Error("invalid response");
    return failure.value;
  }
  if (!response.ok || result.ok !== true) throw new Error("invalid response");
  const success = decodeWorldAuthoringResponse(route, result);
  if (!success.ok) throw new Error("invalid response");
  return success.value;
}

export function createCanvasRemote(options: CanvasRemoteOptions): CanvasRemoteService {
  const basePath = (options.basePath ?? CANVAS_API_BASE_PATH).replace(/\/$/, "");
  const reportPath = options.reportPath ?? MODEL_MCP_REPORT_PATH;
  const snippetBasePath = (options.snippetBasePath ?? PROMPT_SNIPPETS_BASE_PATH).replace(/\/$/, "");
  const nodeHistoryBasePath = (options.nodeHistoryBasePath ?? NODE_HISTORY_BASE_PATH).replace(/\/$/, "");
  const taskActivityBasePath = (options.taskActivityBasePath ?? TASK_ACTIVITY_BASE_PATH).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? getAppPublicFetch();
  const webSocketImpl = options.webSocketImpl ?? (globalThis.WebSocket as unknown as typeof globalThis.WebSocket);
  const location =
    options.location ?? (globalThis.location as unknown as { protocol?: string; host?: string } | undefined) ?? {};
  const canvasBase = `${basePath}/${encodeURIComponent(options.canvasId)}/runs`;
  const captureBase = `${basePath}/${encodeURIComponent(options.canvasId)}/captures`;

  /**
   * page-owned Canvas Session transport（唯一物理 WebSocket）。
   *
   * `openCanvasSession` 创建它；Yjs provider 与 task activity 都通过它的逻辑通道收发。
   */
  let sessionTransport: CanvasSessionTransport | null = null;
  const ensureTransport = (roomEpoch: string | null): CanvasSessionTransport => {
    if (sessionTransport) return sessionTransport;
    sessionTransport = createCanvasSessionTransport({
      url: canvasSessionUrl({ basePath: appPublicUrl(basePath), canvasId: options.canvasId, roomEpoch, location }),
      webSocketImpl,
      ...(options.transport ?? {})
    });
    return sessionTransport;
  };

  async function post(suffix: string, body: unknown): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string; code?: string }> {
    let response: Response;
    try {
      response = await fetchImpl(`${canvasBase}${suffix}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch {
      return { ok: false, error: "无法连接画布服务" };
    }
    const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || (parsed && parsed.ok === false)) {
      const message =
        parsed && typeof parsed.message === "string" && parsed.message !== ""
          ? parsed.message
          : `请求失败（HTTP ${response.status}）`;
      return {
        ok: false,
        error: message,
        ...(parsed && typeof parsed.code === "string" ? { code: parsed.code } : {})
      };
    }
    return { ok: true, body: parsed ?? {} };
  }

  /** 节点历史 JSON 请求：经同一 Canvas Service 出口，返回稳定错误码。 */
  async function nodeHistoryRequest<T>(method: string, suffix: string, body?: unknown): Promise<NodeHistoryResult<T>> {
    let response: Response;
    try {
      response = await fetchImpl(`${nodeHistoryBasePath}${suffix}`, {
        method,
        ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {})
      });
    } catch {
      return { ok: false, code: "unavailable", error: "无法连接节点历史服务" };
    }
    const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      const code = typeof parsed?.code === "string" ? parsed.code : `http-${response.status}`;
      const error = typeof parsed?.message === "string" && parsed.message !== "" ? parsed.message : "节点历史请求失败";
      return { ok: false, code, error, body: parsed } as NodeHistoryResult<T>;
    }
    return { ok: true, value: parsed as T };
  }

  /** 画布任务活动 JSON 请求：经同一 Canvas Service 出口，返回稳定错误码。 */
  async function activityRequest<T>(method: string, suffix: string): Promise<NodeHistoryResult<T>> {
    let response: Response;
    try {
      response = await fetchImpl(`${taskActivityBasePath}${suffix}`, { method });
    } catch {
      return { ok: false, code: "unavailable", error: "无法连接画布任务活动服务" };
    }
    const parsed = (await response.json().catch(() => null)) as { code?: unknown; message?: unknown } | null;
    if (!response.ok) {
      const code = typeof parsed?.code === "string" ? parsed.code : `http-${response.status}`;
      const error = typeof parsed?.message === "string" && parsed.message !== "" ? parsed.message : "画布任务活动请求失败";
      return { ok: false, code, error };
    }
    return { ok: true, value: parsed as T };
  }

  /** 片段目录 JSON 请求：经同一 Canvas Service 出口，返回稳定错误码。 */
  async function snippetRequest<T>(    method: string,
    suffix: string,
    body?: unknown
  ): Promise<SnippetResult<T>> {
    let response: Response;
    try {
      response = await fetchImpl(`${snippetBasePath}${suffix}`, {
        method,
        ...(body !== undefined
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
          : {})
      });
    } catch {
      return { ok: false, code: "unavailable", error: "无法连接片段目录服务" };
    }
    const parsed = (await response.json().catch(() => null)) as
      | { code?: unknown; message?: unknown }
      | null;
    if (!response.ok) {
      const code = typeof parsed?.code === "string" ? sanitizeSnippetCode(parsed.code, response.status) : defaultCode(response.status);
      const error =
        typeof parsed?.message === "string" && parsed.message !== ""
          ? parsed.message
          : `片段目录请求失败（HTTP ${response.status}）`;
      return { ok: false, code, error };
    }
    return { ok: true, value: parsed as T };
  }

  async function sceneAreaRequest(kind: "prepare" | "commit" | "undo" | "redo", body: unknown, signal?: AbortSignal): Promise<import("@woohaa3/contracts").WorldAuthoringPrepareOutcome | import("@woohaa3/contracts").WorldAuthoringExecuteOutcome | import("@woohaa3/contracts").WorldAuthoringHistoryOutcome> {
    try {
      const response = await fetchImpl(`${basePath}/${encodeURIComponent(options.canvasId)}/scene-area-${kind}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal
      });
      return decodeWorldResponse(response, await response.json(), `scene-area-${kind}`) as import("@woohaa3/contracts").WorldAuthoringPrepareOutcome;
    } catch {
      return { ok: false, code: signal?.aborted ? "cancelled" : "not-ready", message: signal?.aborted ? "请求已取消" : "导演区请求失败" };
    }
  }

  async function worldRequest<T>(route: WorldAuthoringResponseRoute, input: { canvasId: string }, signal?: AbortSignal, query?: URLSearchParams): Promise<T> {
    if (input.canvasId !== options.canvasId) return { ok: false, code: "invalid-data", message: "画布不匹配" } as T;
    const { canvasId: _canvasId, ...body } = input;
    try {
      const response = await fetchImpl(`${basePath}/${encodeURIComponent(options.canvasId)}/${route}${query ? `?${query}` : ""}`, {
        method: query ? "GET" : "POST", ...(query ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), signal
      });
      return decodeWorldResponse(response, await response.json(), route) as T;
    } catch {
      return { ok: false, code: signal?.aborted ? "cancelled" : "not-ready", message: signal?.aborted ? "请求已取消" : "画布请求失败" } as T;
    }
  }

  async function worldConversionRequest(kind: "prepare", body: unknown, signal?: AbortSignal): Promise<import("@woohaa3/contracts").WorldConversionPrepareOutcome>;
  async function worldConversionRequest(kind: "commit", body: unknown, signal?: AbortSignal): Promise<import("@woohaa3/contracts").WorldConversionCommitOutcome>;
  async function worldConversionRequest(kind: "prepare" | "commit", body: unknown, signal?: AbortSignal): Promise<import("@woohaa3/contracts").WorldConversionPrepareOutcome | import("@woohaa3/contracts").WorldConversionCommitOutcome> {
    try {
      const response = await fetchImpl(`${basePath}/${encodeURIComponent(options.canvasId)}/world-conversion-${kind}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal
      });
      const result = await response.json() as import("@woohaa3/contracts").WorldConversionPrepareOutcome | import("@woohaa3/contracts").WorldConversionCommitOutcome;
      if (!result || typeof result !== "object" || typeof result.ok !== "boolean") throw new Error("invalid response");
      if (!response.ok && result.ok) throw new Error("invalid response");
      return result;
    } catch {
      return { ok: false, code: signal?.aborted ? "aborted" : "unavailable", message: "画布转换请求失败" };
    }
  }

  /**
   * 原生录制 JSON 请求（change: 2026-10-17-add-native-offscreen-film-set-recording）。
   *
   * 与转换同一出口；`503` 带具体能力码（`recording-unavailable` / `recording-executor-unavailable`），
   * 前端据此显示可恢复原因，不静默回退到浏览器录制。
   */

  return {
    issueWorldToolContext(input, signal) { return worldRequest("world-tool-context", input, signal); },
    revokeWorldToolContext(input, signal) { return worldRequest("world-tool-context-revoke", input, signal); },
    saveWorldCamera(input, signal) { return worldRequest("world-camera-save", input, signal); },
    restoreWorldCamera(input, signal) { return worldRequest("world-camera-restore", input, signal); },
    listWorldCameraHistory(input, signal) {
      const query = new URLSearchParams({ cameraId: input.cameraId });
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      return worldRequest("world-camera-history", input, signal, query);
    },
    async prepareSceneArea(input, signal) {
      if (input.canvasId !== options.canvasId) return { ok: false, code: "invalid-data", message: "画布不匹配" };
      return sceneAreaRequest("prepare", { areaId: input.areaId }, signal) as Promise<import("@woohaa3/contracts").WorldAuthoringPrepareOutcome>;
    },
    async executeSceneArea(input, signal) {
      if (input.canvasId !== options.canvasId) return { ok: false, code: "invalid-data", message: "画布不匹配" };
      const { canvasId: _canvasId, ...body } = input;
      return sceneAreaRequest("commit", body, signal) as Promise<import("@woohaa3/contracts").WorldAuthoringExecuteOutcome>;
    },
    async historySceneArea(direction, input, signal) {
      if (input.canvasId !== options.canvasId) return { ok: false, code: "invalid-data", message: "画布不匹配" };
      const { canvasId: _canvasId, ...body } = input;
      return sceneAreaRequest(direction, body, signal) as Promise<import("@woohaa3/contracts").WorldAuthoringHistoryOutcome>;
    },
    async prepareWorldConversion(input, signal) {
      if (input.canvasId !== options.canvasId) return { ok: false, code: "canvas-mismatch", message: "画布不匹配" };
      return worldConversionRequest("prepare", { nodeIds: input.nodeIds }, signal);
    },
    async commitWorldConversion(input, signal) {
      if (input.canvasId !== options.canvasId) return { ok: false, code: "canvas-mismatch", message: "画布不匹配" };
      const { canvasId: _canvasId, ...body } = input;
      return worldConversionRequest("commit", body, signal);
    },
    openCanvasSession(canvasId, roomEpoch) {
      if (canvasId !== options.canvasId) {
        throw new Error("Canvas Session 已绑定当前页面画布");
      }
      return ensureTransport(roomEpoch).channel(SESSION_CHANNEL.CANVAS_YJS);
    },

    closeCanvasSession() {
      sessionTransport?.dispose();
      sessionTransport = null;
    },

    /**
     * 显式重建物理连接（change: 2026-10-21-recover-canvas-connection-explicitly）。
     *
     * 只重建传输、不 dispose 通道订阅者：Yjs provider 与 task activity 的订阅仍在，
     * 传输 open 后会重新触发各通道的 open 握手（state vector / activity cursor）。
     * 还没创建过 transport 时为空操作（调用方应改走完整 attach）。
     */
    reconnectCanvasSession() {
      sessionTransport?.reconnect();
    },

    async run(request: CanvasRunRequest): Promise<CanvasRunResult> {
      const result = await post("", request);
      if (!result.ok) return result;
      const runId = typeof result.body.runId === "string" ? result.body.runId : request.runId;
      const jobId = typeof result.body.jobId === "string" ? result.body.jobId : request.jobId;
      return { ok: true, runId, jobId };
    },

    async freezeWorldCapture(input) {
      const renderer = options.renderWorldCapture;
      if (!renderer) {
        return { ok: false, code: "renderer-unavailable", error: "当前页面没有可用的世界镜头渲染器" };
      }
      // 1. 预备：由宿主给出当前 canonical 取景的版本键与精确输出尺寸。
      let prepared: Response;
      try {
        prepared = await fetchImpl(`${captureBase}-page-prepare`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cameraId: input.cameraId }),
          ...(input.signal ? { signal: input.signal } : {})
        });
      } catch {
        return { ok: false, code: "capture-unavailable", error: "无法连接取景服务" };
      }
      const preparedBody = (await prepared.json().catch(() => null)) as Record<string, unknown> | null;
      if (
        !preparedBody ||
        preparedBody.ok !== true ||
        typeof preparedBody.width !== "number" ||
        typeof preparedBody.height !== "number" ||
        preparedBody.key === undefined
      ) {
        return {
          ok: false,
          code: typeof preparedBody?.code === "string" ? preparedBody.code : `http-${prepared.status}`,
          error: typeof preparedBody?.message === "string" && preparedBody.message !== ""
            ? preparedBody.message
            : `取景预备失败（HTTP ${prepared.status}）`
        };
      }
      const width = Math.trunc(preparedBody.width);
      const height = Math.trunc(preparedBody.height);
      // 2. 页面渲染：与页面镜头卡片同一 Bevy 运行时，不含等距网格。
      const rendered = await renderer({ cameraId: input.cameraId, width, height });
      if (!rendered.ok) {
        return { ok: false, code: rendered.code, error: "页面渲染取景失败" };
      }
      // 3. 提交：宿主校验版本仍当前后经可信 Media 保存并冻结。
      return postPageCommit(captureBase, fetchImpl, {
        cameraId: input.cameraId,
        key: preparedBody.key,
        png: rendered.png,
        width,
        height,
        ...(input.signal ? { signal: input.signal } : {})
      });
    },

    async listPendingPageCaptures(): Promise<PageCapturePendingResult> {
      let response: Response;
      try {
        response = await fetchImpl(`${captureBase}-page-pending`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({})
        });
      } catch {
        return { ok: false, code: "capture-unavailable", error: "无法连接取景服务" };
      }
      const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (parsed && parsed.ok === true && Array.isArray(parsed.captures)) {
        return { ok: true, captures: parsed.captures as PageCapturePendingEntry[] };
      }
      return { ok: false, code: `http-${response.status}`, error: `读取待取景失败（HTTP ${response.status}）` };
    },

    async commitPageCapture(input): Promise<CanvasCaptureFreezeResult> {
      return postPageCommit(captureBase, fetchImpl, input);
    },

    async commitPageVideoCapture(input): Promise<CanvasCaptureFreezeResult> {
      let response: Response;
      try {
        response = await fetchImpl(`${captureBase}-page-commit-video`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            cameraId: input.cameraId,
            key: input.key,
            mp4Base64: bytesToBase64(input.mp4),
            width: input.width,
            height: input.height
          })
        });
      } catch {
        return { ok: false, code: "capture-unavailable", error: "无法连接取景服务" };
      }
      const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (parsed && parsed.ok === true) {
        return { ok: true, binding: parsed.binding as import("@woohaa3/contracts").WorldCaptureGenerationBinding };
      }
      return {
        ok: false,
        code: typeof parsed?.code === "string" ? parsed.code : `http-${response.status}`,
        error: typeof parsed?.message === "string" ? parsed.message : `页面视频取景提交失败（HTTP ${response.status}）`
      };
    },

    async listWorldCaptureStatuses(): Promise<WorldCaptureStatusResult> {
      let response: Response;
      try {
        response = await fetchImpl(`${captureBase}-status`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({})
        });
      } catch {
        return { ok: false, code: "capture-unavailable", error: "无法连接取景服务" };
      }
      const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (parsed && parsed.ok === true && Array.isArray(parsed.statuses)) {
        return {
          ok: true,
          statuses: parsed.statuses as import("@woohaa3/contracts").WorldCaptureFramingStatus[]
        };
      }
      return { ok: false, code: `http-${response.status}`, error: `读取镜头状态失败（HTTP ${response.status}）` };
    },

    async cancel(input): Promise<CanvasCancelResult> {
      const result = await post("/cancel", { nodeId: input.nodeId, runId: input.runId });
      return result.ok ? { ok: true } : result;
    },

    async reportModelScript(report: ModelScriptReport): Promise<void> {
      await fetchImpl(reportPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(report)
      }).catch(() => undefined);
    },

    async listNodeHistory(input): Promise<NodeHistoryResult<NodeGenerationHistoryListPage>> {
      const params = new URLSearchParams();
      if (input.cursor) params.set("cursor", input.cursor);
      if (input.limit) params.set("limit", String(input.limit));
      const suffix = params.toString() ? `?${params.toString()}` : "";
      return nodeHistoryRequest<NodeGenerationHistoryListPage>(
        "GET",
        `/${encodeURIComponent(input.canvasId)}/${encodeURIComponent(input.nodeId)}${suffix}`
      );
    },

    async listCanvasHistory(input): Promise<NodeHistoryResult<CanvasGenerationHistoryListPage>> {
      const params = new URLSearchParams();
      if (input.summary) params.set("summary", "true");
      if (input.summaryNodeId) params.set("summaryNodeId", input.summaryNodeId);
      if (input.cursor) params.set("cursor", input.cursor);
      if (input.limit) params.set("limit", String(input.limit));
      if (input.kind) params.set("kind", input.kind);
      const suffix = params.toString() ? `?${params.toString()}` : "";
      return nodeHistoryRequest<CanvasGenerationHistoryListPage>(
        "GET",
        `/${encodeURIComponent(input.canvasId)}${suffix}`
      );
    },

    async getNodeHistoryDetail(input): Promise<NodeHistoryResult<NodeGenerationHistoryDetail>> {
      const result = await nodeHistoryRequest<{ entry: NodeGenerationHistoryDetail }>(
        "GET",
        `/${encodeURIComponent(input.canvasId)}/${encodeURIComponent(input.nodeId)}/${encodeURIComponent(input.entryId)}`
      );
      return result.ok ? { ok: true, value: result.value.entry } : result;
    },

    async applyNodeHistory(input): Promise<NodeHistoryResult<{ entryId: string; revision: number; alreadyCurrent: boolean }>> {
      const result = await nodeHistoryRequest<{ ok: true; entryId: string; revision: number; alreadyCurrent: boolean }>(
        "POST",
        `/${encodeURIComponent(input.canvasId)}/${encodeURIComponent(input.nodeId)}/${encodeURIComponent(input.entryId)}/apply`,
        input.expectedCurrentIdentity !== undefined ? { expectedCurrentIdentity: input.expectedCurrentIdentity } : undefined
      );
      return result.ok
        ? { ok: true, value: { entryId: result.value.entryId, revision: result.value.revision, alreadyCurrent: result.value.alreadyCurrent } }
        : result;
    },

    async clearNodeHistory(input): Promise<NodeHistoryResult<{ removed: number }>> {
      const result = await nodeHistoryRequest<{ ok: true; removed: number }>(
        "POST",
        `/${encodeURIComponent(input.canvasId)}/${encodeURIComponent(input.nodeId)}/clear`
      );
      return result.ok ? { ok: true, value: { removed: result.value.removed } } : result;
    },

    async mergeNodeHistory(input): Promise<NodeHistoryResult<MergeNodeHistoryReceipt>> {
      const result = await nodeHistoryRequest<{ ok: true } & MergeNodeHistoryReceipt>(
        "POST",
        `/${encodeURIComponent(input.canvasId)}/${encodeURIComponent(input.targetNodeId)}/merge`,
        {
          sourceNodeId: input.sourceNodeId,
          operationId: input.operationId,
          ...(input.expectedSourceCurrentIdentity !== undefined
            ? { expectedSourceCurrentIdentity: input.expectedSourceCurrentIdentity }
            : {}),
          ...(input.expectedTargetCurrentIdentity !== undefined
            ? { expectedTargetCurrentIdentity: input.expectedTargetCurrentIdentity }
            : {})
        }
      );
      if (!result.ok) return result;
      const { ok: _ok, ...receipt } = result.value;
      return { ok: true, value: receipt };
    },

    nodeHistoryPreviewUrl(input): string {
      return appPublicUrl(nodeHistoryUrlFor(input));
    },

    async verifyImageProjectReferences(input) {
      return nodeHistoryRequest<ImageProjectReferencesResult>("POST",
        `/${encodeURIComponent(input.canvasId)}/_/image-project-references`, input);
    },
    async editBegin(input): Promise<NodeHistoryResult<EditSessionBeginResponse>> {
      return nodeHistoryRequest<EditSessionBeginResponse>(
        "POST",
        `/${encodeURIComponent(input.canvasId)}/${encodeURIComponent(input.nodeId)}/edit-begin`,
        input
      );
    },

    async editComplete(input): Promise<EditCompleteResult> {
      const result = await nodeHistoryRequest<{ receipt: EditSessionCompletionReceipt }>(
        "POST",
        `/${encodeURIComponent(input.canvasId)}/${encodeURIComponent(input.nodeId)}/edit-complete`,
        input
      );
      if (result.ok) return { ok: true, receipt: result.value.receipt };
      const body = result.body as { receipt?: EditSessionCompletionReceipt } | null | undefined;
      return { ok: false, code: result.code, error: result.error, ...(body?.receipt ? { receipt: body.receipt } : {}) };
    },

    async editStatus(input): Promise<NodeHistoryResult<EditSessionCompletionReceipt>> {
      const params = new URLSearchParams({ requestId: input.requestId });
      const result = await nodeHistoryRequest<{ receipt: EditSessionCompletionReceipt }>(
        "GET",
        `/${encodeURIComponent(input.canvasId)}/${encodeURIComponent(input.nodeId)}/edit-status?${params.toString()}`
      );
      return result.ok ? { ok: true, value: result.value.receipt } : result;
    },

    async editAbandon(input): Promise<NodeHistoryResult<{ status: "abandoned" }>> {
      return nodeHistoryRequest<{ status: "abandoned" }>(
        "POST",
        `/${encodeURIComponent(input.canvasId)}/${encodeURIComponent(input.nodeId)}/edit-abandon`,
        { requestId: input.requestId }
      );
    },

    async taskActivitySnapshot(input): Promise<NodeHistoryResult<CanvasTaskActivitySnapshot>> {
      const params = new URLSearchParams();
      if (input.cursor) params.set("cursor", input.cursor);
      if (input.limit) params.set("limit", String(input.limit));
      const suffix = params.toString() ? `?${params.toString()}` : "";
      return activityRequest<CanvasTaskActivitySnapshot>(
        "GET",
        `/${encodeURIComponent(input.canvasId)}${suffix}`
      );
    },

    /**
     * 有限 JSON 增量（断线补偿 / 冷启动；不持有长连接）
     * （change: unify-canvas-session-websocket，design D5）。
     */
    async taskActivityChanges(input): Promise<NodeHistoryResult<CanvasTaskActivityEventBatch>> {
      const params = new URLSearchParams({ after: String(input.after) });
      if (input.limit) params.set("limit", String(input.limit));
      return activityRequest<CanvasTaskActivityEventBatch>(
        "GET",
        `/${encodeURIComponent(input.canvasId)}/changes?${params.toString()}`
      );
    },

    /**
     * 订阅当前 canvas 的 `task-activity` 逻辑通道。
     *
     * 复用 page-owned Canvas Session（唯一物理 socket）：这里只发送 `subscribe` 并分发
     * `record`。channel 重连由 transport 统一负责，因此**没有**独立 retry timer；
     * 每帧只交给对应通道 consumer，且 cursor 只在成功解码并交付后由调用方推进。
     */
    subscribeTaskActivity(input): () => void {
      if (input.canvasId !== options.canvasId) {
        return () => undefined;
      }
      const transport = ensureTransport(null);
      const socket = transport.channel(SESSION_CHANNEL.TASK_ACTIVITY);
      let stopped = false;
      let cursor = input.cursor;

      const detachMessage = socket.onMessage((payload) => {
        if (stopped) return;
        let message;
        try {
          message = decodeTaskActivityServerMessage(payload);
        } catch {
          // 畸形记录只忽略该帧（transport 已做通道隔离）。
          return;
        }
        if (message.type === "record") {
          input.onRecord(message.record, message.cursor);
          // cursor 只在记录成功解码并交付后推进（receipt of bytes 不算确认）。
          cursor = Math.max(cursor, message.cursor);
          return;
        }
        if (message.type === "error") {
          input.onError?.(new Error(message.code));
        }
      });
      // 物理连接若尚未就绪，`onOpen` 会在每次（重）连接后触发，重新协商最后确认 cursor。
      const detachOpen = socket.onOpen?.(() => {
        if (stopped) return;
        socket.send(encodeTaskActivitySubscribe({ type: "subscribe", after: cursor }));
      }) ?? (() => undefined);

      return () => {
        stopped = true;
        detachMessage();
        detachOpen();
      };
    },

    async listSnippets(query: PromptSnippetListQuery = {}): Promise<SnippetResult<PromptSnippetListResult>> {
      const params = new URLSearchParams();
      if (query.query) params.set("query", query.query);
      if (query.filter) params.set("filter", query.filter);
      if (query.tagId) params.set("tagId", query.tagId);
      if (query.cursor) params.set("cursor", query.cursor);
      if (query.limit) params.set("limit", String(query.limit));
      const suffix = params.toString() ? `?${params.toString()}` : "";
      return snippetRequest<PromptSnippetListResult>("GET", suffix);
    },

    async getSnippet(snippetId: string): Promise<SnippetResult<PromptSnippet>> {
      const result = await snippetRequest<{ snippet: PromptSnippet }>("GET", `/${encodeURIComponent(snippetId)}`);
      return result.ok ? { ok: true, value: result.value.snippet } : result;
    },

    async createSnippet(input: CreatePromptSnippetInput): Promise<SnippetResult<PromptSnippet>> {
      const result = await snippetRequest<{ snippet: PromptSnippet }>("POST", "", input);
      return result.ok ? { ok: true, value: result.value.snippet } : result;
    },

    async updateSnippet(input: UpdatePromptSnippetInput): Promise<SnippetResult<PromptSnippet>> {
      const result = await snippetRequest<{ snippet: PromptSnippet }>("PATCH", `/${encodeURIComponent(input.snippetId)}`, {
        expectedRevision: input.expectedRevision,
        name: input.name,
        body: input.body,
        materials: input.materials,
        tagIds: input.tagIds
      });
      return result.ok ? { ok: true, value: result.value.snippet } : result;
    },

    async deleteSnippet(snippetId: string): Promise<SnippetResult<null>> {
      return snippetRequest<null>("DELETE", `/${encodeURIComponent(snippetId)}`);
    },

    async listSnippetTags(): Promise<SnippetResult<Array<PromptSnippetTag & { snippetCount: number }>>> {
      const result = await snippetRequest<{ items: Array<PromptSnippetTag & { snippetCount: number }> }>("GET", "/tags");
      return result.ok ? { ok: true, value: result.value.items } : result;
    },

    async createSnippetTag(input: CreatePromptSnippetTagInput): Promise<SnippetResult<PromptSnippetTag>> {
      const result = await snippetRequest<{ tag: PromptSnippetTag }>("POST", "/tags", input);
      return result.ok ? { ok: true, value: result.value.tag } : result;
    },

    async renameSnippetTag(input: RenamePromptSnippetTagInput): Promise<SnippetResult<PromptSnippetTag>> {
      const result = await snippetRequest<{ tag: PromptSnippetTag }>("PATCH", `/tags/${encodeURIComponent(input.tagId)}`, {
        expectedRevision: input.expectedRevision,
        name: input.name
      });
      return result.ok ? { ok: true, value: result.value.tag } : result;
    },

    async deleteSnippetTag(tagId: string): Promise<SnippetResult<null>> {
      return snippetRequest<null>("DELETE", `/tags/${encodeURIComponent(tagId)}`);
    },

    async resolveSnippetMaterial(storageKey: string): Promise<SnippetResult<{ storageKey: string; resolvable: boolean }>> {
      return snippetRequest<{ storageKey: string; resolvable: boolean }>(
        "GET",
        `/material?storageKey=${encodeURIComponent(storageKey)}`
      );
    }
  };
}

function sanitizeSnippetCode(code: string, status: number): PromptSnippetErrorCode | "unauthorized" | "unavailable" {
  if (code === "unauthorized") return "unauthorized";
  if (code === "SNIPPET_NOT_FOUND" || code === "SNIPPET_NAME_CONFLICT" || code === "SNIPPET_READ_ONLY" ||
      code === "TAG_NOT_FOUND" || code === "TAG_NAME_CONFLICT" || code === "SNIPPET_INVALID" ||
      code === "SNIPPET_OPERATION_CONFLICT" || code === "SNIPPET_REVISION_CONFLICT") {
    return code;
  }
  return defaultCode(status);
}

function defaultCode(status: number): "unauthorized" | "unavailable" {
  if (status === 401 || status === 403) return "unauthorized";
  return "unavailable";
}
