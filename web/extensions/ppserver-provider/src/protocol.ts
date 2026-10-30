/**
 * ppserver 任务路由器的请求体构造与响应解读（纯函数，无网络）。
 *
 * 形状取自线上实际调用方 `sdpppx-services`（PS 插件）：
 * - 创建：`POST /tasks/create_stream`，body `{ templateId, payload, platformConfig, options, tenantId? }`；
 *   响应是 SSE，首条 `created` 事件带 `job_id`；
 * - 状态：`POST /tasks/status`，body `{ taskId, platformConfig, options }`，返回 `{ status }`；
 * - 结果：`POST /tasks/result`，返回 `{ raw, costMoney }`；
 * - 取消：`POST /tasks/cancel`。
 *
 * **状态取值**只有 `succeeded | failed | cancelled`，其余（含缺失）一律按进行中处理 ——
 * 这是调用方的既有约定：宁可多轮询一次，也不要把排队中的任务判死。
 */

export type TaskState = "pending" | "running" | "succeeded" | "failed" | "cancelled";

/** 与 Pod 侧一致的序列化：`options` 里只带网关认识的字段，`context` 折进 `metadata`。 */
export type RequestOptions = {
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
  context?: Record<string, unknown>;
};

export type PlatformConfig = Record<string, unknown>;

/** `options` 的线上形状：SDK 的 options 摊平后再挂上 context。 */
export function serializeOptions(options?: RequestOptions, context?: Record<string, unknown>): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = { ...(options?.metadata ?? {}), ...(context ?? {}) };
  if (options?.metadata && Object.keys(options.metadata).length > 0) merged.options = { ...options.metadata };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function buildCreateStreamBody(input: {
  templateId: string;
  payload: Record<string, unknown>;
  platformConfig?: PlatformConfig;
  options?: RequestOptions;
  tenantId?: string;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    templateId: input.templateId,
    payload: input.payload ?? {},
    platformConfig: input.platformConfig,
    options: serializeOptions(input.options)
  };
  if (input.tenantId) body.tenantId = input.tenantId;
  return body;
}

export function buildTaskBody(input: {
  taskId: string;
  platformConfig?: PlatformConfig;
  options?: RequestOptions;
}): Record<string, unknown> {
  return {
    taskId: input.taskId,
    platformConfig: input.platformConfig,
    options: serializeOptions(input.options)
  };
}

/** `succeeded | failed | cancelled` 之外都算进行中。 */
export function readTaskState(payload: unknown): TaskState {
  const record = isRecord(payload) ? payload : {};
  const status = typeof record.status === "string" ? record.status.trim().toLowerCase() : "";
  if (status === "succeeded" || status === "success" || status === "completed") return "succeeded";
  if (status === "failed" || status === "error") return "failed";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "running" || status === "processing" || status === "in_progress") return "running";
  return "pending";
}

/** 失败原因：`error` / `message` 优先，其次把整个响应截一段当说明（不猜原因）。 */
export function readTaskError(payload: unknown): string {
  const record = isRecord(payload) ? payload : {};
  for (const key of ["error", "message", "msg"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 400);
    if (isRecord(value) && typeof value.message === "string" && value.message.trim()) {
      return value.message.trim().slice(0, 400);
    }
  }
  return "ppserver 任务失败，未返回原因";
}

/** 进度：0–1 或 0–100 都收，统一成 0–100 的整数。取不到就不给。 */
export function readProgress(payload: unknown): number | undefined {
  const record = isRecord(payload) ? payload : {};
  for (const key of ["progress", "percent", "percentage"]) {
    const raw = record[key];
    const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
    if (!Number.isFinite(value) || value < 0) continue;
    return Math.round(value <= 1 ? value * 100 : value);
  }
  return undefined;
}

/** 创建响应里的 `job_id`（SSE `created` 事件，或直接返回 JSON 时的 `jobId`）。 */
export function readJobId(payload: unknown): string {
  const record = isRecord(payload) ? payload : {};
  for (const key of ["job_id", "jobId", "taskId", "task_id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

/**
 * 结果地址。
 *
 * `/tasks/result` 的 `raw` 是「任意 JSON」，PS 插件按 `Array<{url}>` 消费。这里不假设只有
 * `url`：递归收集所有 http(s) 地址，交给 `extractOutputValues` 再过滤一遍。
 */
export function collectResultUrls(payload: unknown): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown, depth: number): void => {
    if (depth > 6) return;
    if (typeof node === "string") {
      if (/^https?:\/\//i.test(node) && !seen.has(node)) {
        seen.add(node);
        urls.push(node);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (!isRecord(node)) return;
    for (const key of ["url", "urls", "uri", "image", "images", "video", "videos", "output", "outputs", "result", "results", "raw", "data"]) {
      if (key in node) visit(node[key], depth + 1);
    }
  };
  visit(payload, 0);
  return urls;
}

/** 费用：结果里的 `costMoney` / `charge`，用于界面展示「本次消耗」。 */
export function readCost(payload: unknown): number | undefined {
  const record = isRecord(payload) ? payload : {};
  for (const key of ["costMoney", "charge", "cost"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** 从一段 SSE 文本里取出完整事件；返回事件数组与余下的半截缓冲。 */
export function parseSseBuffer(buffer: string): {
  events: Array<{ type: string; data: Record<string, unknown> }>;
  remainder: string;
} {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const blocks = buffer.split(/\r?\n\r?\n/);
  const remainder = blocks.pop() ?? "";
  for (const block of blocks) {
    let type = "";
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!type && dataLines.length === 0) continue;
    const raw = dataLines.join("\n");
    let data: Record<string, unknown> = {};
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        data = isRecord(parsed) ? parsed : { value: parsed };
      } catch {
        data = { text: raw };
      }
    }
    events.push({ type, data });
  }
  return { events, remainder };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
