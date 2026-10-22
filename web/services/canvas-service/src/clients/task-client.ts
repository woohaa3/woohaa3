/**
 * Canvas → Task 协议 client（change: split-web-runtime-services，任务 5.3 / 5.4）。
 *
 * Canvas 通过它以稳定 `workerTaskKey` 幂等 submit/cancel，并主动消费 Task 的持久化
 * status/history（design D4）：**不采用 Task → Canvas webhook**，投影恢复责任在 Canvas。
 * 不 import Task 实现，也不持有 provider 凭据。
 */
import { buildInternalHeaders,
  createCorrelationId,
  hashStorageKeyForLog,
  retryDelayMs,
  shouldRetryTransport,
  withTimeout,
  type ProtocolErrorBody,
  type TaskExecutionDetail,
  type TaskSubmitResponse,
  type TaskHistoryQuery,
  type CanvasTaskActivitySnapshot,
  type CanvasTaskActivityEventBatch } from "@woohaa3/contracts";

export type CanvasTaskClientOptions = {
  baseUrl: string;
  serviceToken?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof globalThis.fetch;
  logger?: (event: Record<string, unknown>) => void;
};

export class TaskClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "TaskClientError";
    this.code = code;
    this.status = status;
  }
}

export type CanvasTaskClient = {
  submit(request: unknown): Promise<TaskSubmitResponse>;
  cancel(workerTaskKey: string): Promise<void>;
  status(workerTaskKey: string): Promise<TaskExecutionDetail | null>;
  history(query: { after?: number; limit?: number }): Promise<{ items: TaskExecutionDetail[]; cursor: number }>;
  /** 画布活动安全快照（change: 2026-09-29-add-canvas-task-activity-feed）。 */
  canvasActivity(canvasId: string, query?: { cursor?: string; limit?: number }): Promise<CanvasTaskActivitySnapshot>;
  /** 自 cursor 起的画布活动变更（断线补偿）。 */
  canvasActivitySince(canvasId: string, after: number, limit?: number): Promise<CanvasTaskActivityEventBatch>;
  /**
   * 有限 JSON 画布活动增量（relay 追赶与浏览器 HTTP 补偿共用）
   * （change: unify-canvas-session-websocket，design D4/D5）。与 `canvasActivitySince` 同形状。
   */
  canvasActivityChanges(canvasId: string, after: number, limit?: number): Promise<CanvasTaskActivityEventBatch>;
};

export function createCanvasTaskClient(options: CanvasTaskClientOptions): CanvasTaskClient {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const maxRetries = options.maxRetries ?? 2;
    for (let attempt = 0; ; attempt += 1) {
      const correlationId = createCorrelationId();
      try {
        const response = await withTimeout(
          (signal) =>
            fetchImpl(`${baseUrl}${path}`, {
              method,
              headers: buildInternalHeaders({ serviceToken: options.serviceToken, correlationId }),
              ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
              signal
            }),
          options.timeoutMs
        );
        const parsed = (await response.json().catch(() => null)) as unknown;
        if (response.ok) return parsed as T;
        const errorBody = parsed as ProtocolErrorBody | null;
        const code = errorBody?.code ?? "storage-failed";
        if (shouldRetryTransport({ attempt, status: response.status, code, maxRetries })) {
          await delay(retryDelayMs(attempt));
          continue;
        }
        throw new TaskClientError(code, errorBody?.message ?? "任务服务请求失败", response.status);
      } catch (error) {
        if (error instanceof TaskClientError) throw error;
        if (shouldRetryTransport({ attempt, maxRetries })) {
          await delay(retryDelayMs(attempt));
          continue;
        }
        throw new TaskClientError("unavailable", "任务服务暂时不可用");
      }
    }
  }

  return {
    submit(payload) {
      const workerTaskKey = (payload as { workerTaskKey: string }).workerTaskKey;
      options.logger?.({ event: "task-submit", workerTaskKey });
      return call<TaskSubmitResponse>("PUT", `/internal/v1/tasks/${encodeURIComponent(workerTaskKey)}`, payload);
    },
    async cancel(workerTaskKey) {
      options.logger?.({ event: "task-cancel", workerTaskKey });
      await call<unknown>("POST", `/internal/v1/tasks/${encodeURIComponent(workerTaskKey)}/cancel`);
    },
    async status(workerTaskKey) {
      try {
        return await call<TaskExecutionDetail>("GET", `/internal/v1/tasks/${encodeURIComponent(workerTaskKey)}`);
      } catch (error) {
        if (error instanceof TaskClientError && error.code === "task-not-found") return null;
        throw error;
      }
    },
    async history(query) {
      const params = new URLSearchParams();
      if (query.after !== undefined) params.set("after", String(query.after));
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      const result = await call<{ items: TaskExecutionDetail[]; cursor: number }>(
        "GET",
        `/internal/v1/task-history?${params.toString()}`
      );
      options.logger?.({ event: "task-history", count: result.items.length });
      return result;
    },
    async canvasActivity(canvasId, query = {}) {
      const params = new URLSearchParams();
      if (query.cursor !== undefined) params.set("cursor", query.cursor);
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const result = await call<CanvasTaskActivitySnapshot>(
        "GET",
        `/internal/v1/canvases/${encodeURIComponent(canvasId)}/task-activity${suffix}`
      );
      options.logger?.({ event: "task-canvas-activity", count: result.active.length + result.recent.length });
      return result;
    },
    async canvasActivitySince(canvasId, after, limit) {
      const params = new URLSearchParams({ after: String(after) });
      if (limit !== undefined) params.set("limit", String(limit));
      return call<CanvasTaskActivityEventBatch>(
        "GET",
        `/internal/v1/canvases/${encodeURIComponent(canvasId)}/task-activity/events?${params.toString()}`
      );
    },
    async canvasActivityChanges(canvasId, after, limit) {
      const params = new URLSearchParams({ after: String(after) });
      if (limit !== undefined) params.set("limit", String(limit));
      return call<CanvasTaskActivityEventBatch>(
        "GET",
        `/internal/v1/canvases/${encodeURIComponent(canvasId)}/task-activity/changes?${params.toString()}`
      );
    }
  };
}

export { hashStorageKeyForLog, type TaskHistoryQuery };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
