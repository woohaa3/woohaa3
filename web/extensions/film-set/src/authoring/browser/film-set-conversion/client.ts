/**
 * 「转为片场」转换客户端：稳定请求身份 + 提交/查询/取消/重试 + 模型候选
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.4–3.8 / design D1/D4/D5）。
 *
 * 唯一浏览器出口：复用宿主注入的 `CanvasRemoteService`（不新建 fetch/WebSocket，也不拼服务端
 * 路径）。每个「转为片场」动作在**激活时**固定 `(sourceNodeId, requestId, targetNodeId)`，
 * 之后 selection 变化不重定位请求；双击/查询/重试复用同一 requestId（服务端幂等）。
 */
import type { CanvasRemoteService, NodeHistoryResult } from "@woohaa3/frontend/extension-api";
import type { FilmSetConversionModelCandidate, FilmSetConversionReceipt, FilmSetConversionRequest, FilmSetConversionSettings, FilmSetConversionSourceKind, FilmSetConversionStatus } from "@woohaa3/contracts";

/** 一次转换动作的稳定身份（激活时固定；不随之后 selection 变化）。 */
export type FilmSetConversionIdentity = {
  sourceNodeId: string;
  sourceKind: FilmSetConversionSourceKind;
  requestId: string;
  targetNodeId: string;
};

/** 新请求 ID（幂等身份）；重试/查询复用同值。 */
export function createFilmSetConversionRequestId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `film-set-conversion-${random}`;
}

/** 新目标节点 ID（与源节点不同）。 */
export function createFilmSetConversionTargetId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `filmset-${random}`;
}

/** 为一次动作固定身份（同一动作的提交/状态/重试共用）。 */
export function createFilmSetConversionIdentity(input: {
  sourceNodeId: string;
  sourceKind: FilmSetConversionSourceKind;
}): FilmSetConversionIdentity {
  return {
    sourceNodeId: input.sourceNodeId,
    sourceKind: input.sourceKind,
    requestId: createFilmSetConversionRequestId(),
    targetNodeId: createFilmSetConversionTargetId()
  };
}

/** 构造规范请求体（canvasId 由路由补充；settings 为空时省略，保证幂等 hash 稳定）。 */
export function buildFilmSetConversionRequest(input: {
  canvasId: string;
  identity: FilmSetConversionIdentity;
  settings: FilmSetConversionSettings;
}): FilmSetConversionRequest {
  const settings: FilmSetConversionSettings = {};
  if (input.settings.connection) settings.connection = { ...input.settings.connection };
  if (input.settings.reasoningEffort) settings.reasoningEffort = input.settings.reasoningEffort;
  if (input.settings.modelKey) settings.modelKey = input.settings.modelKey;
  if (input.settings.instruction && input.settings.instruction.trim() !== "") settings.instruction = input.settings.instruction;
  if (input.settings.range) settings.range = input.settings.range;
  return {
    canvasId: input.canvasId,
    requestId: input.identity.requestId,
    sourceNodeId: input.identity.sourceNodeId,
    targetNodeId: input.identity.targetNodeId,
    sourceKind: input.identity.sourceKind,
    ...(Object.keys(settings).length > 0 ? { settings } : {})
  };
}

export type FilmSetConversionSubmitResult =
  | { ok: true; receipt: FilmSetConversionReceipt & { ok: true }; status: FilmSetConversionStatus }
  | { ok: false; code: string; error: string };

/**
 * 转换客户端：所有方法都经 `CanvasRemoteService`；不做本地任务状态缓存
 * （真实状态来自服务端，避免制造第二份任务状态）。
 */
export type FilmSetConversionClient = {
  models(): Promise<NodeHistoryResult<{ models: FilmSetConversionModelCandidate[] }>>;
  submit(request: FilmSetConversionRequest): Promise<FilmSetConversionSubmitResult>;
  status(input: { canvasId: string; requestId: string }): Promise<NodeHistoryResult<{ status: FilmSetConversionStatus | null }>>;
  cancel(input: { canvasId: string; requestId: string }): Promise<NodeHistoryResult<{ status: FilmSetConversionStatus }>>;
  retry(input: { canvasId: string; requestId: string }): Promise<FilmSetConversionSubmitResult>;
};

function toSubmitResult(
  result: NodeHistoryResult<{ receipt: FilmSetConversionReceipt & { ok: true }; status: FilmSetConversionStatus }>
): FilmSetConversionSubmitResult {
  return result.ok ? { ok: true, receipt: result.value.receipt, status: result.value.status } : { ok: false, code: result.code, error: result.error };
}

export function createFilmSetConversionClient(remote: CanvasRemoteService): FilmSetConversionClient {
  return {
    models: () => remote.filmSetConversionModels(),
    submit: async (request) => toSubmitResult(await remote.filmSetConversionSubmit(request)),
    status: (input) => remote.filmSetConversionStatus(input),
    cancel: (input) => remote.filmSetConversionCancel(input),
    retry: async (input) => toSubmitResult(await remote.filmSetConversionRetry(input))
  };
}
