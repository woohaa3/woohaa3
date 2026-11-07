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

/**
 * 文本（language）模板的 payload 形状。
 *
 * 宿主通用输入把文本任务拼成聊天格式：`prompt` 是消息数组、系统提示叫 `system`、上限叫
 * `maxTokens`。ppserver 的 `crun/gpt-5.6-*` 这类 handler 要的却是**字符串** `prompt`、
 * `systemPrompt`、`maxOutputTokens`，并带 `apiMode`。数组形状的 `prompt` 会被判为空，
 * 上游报「requires a non-empty input, prompt, or image」。
 *
 * 只转这一类已知的聊天形状，其它字段原样保留；已经是字符串的 `prompt` 不动（幂等）。
 * 参考图/视频/音频在文本模板里没有对应字段，这里不传（改写类任务只有文本）。
 */
export function toLanguagePayload(input: Record<string, unknown>): Record<string, unknown> {
  const { prompt, system, maxTokens, ...rest } = input;
  const payload: Record<string, unknown> = { apiMode: "messages", stream: false, ...rest };
  payload.prompt = typeof prompt === "string" ? prompt : promptTextOf(prompt);
  if (typeof system === "string" && system.trim() !== "" && payload.systemPrompt === undefined) {
    payload.systemPrompt = system;
  }
  if (typeof maxTokens === "number" && payload.maxOutputTokens === undefined) {
    payload.maxOutputTokens = maxTokens;
  }
  return payload;
}

/** 从聊天消息数组里取出文本；多条消息或多段文本按顺序换行拼接。 */
function promptTextOf(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  const texts: string[] = [];
  for (const message of prompt) {
    const content = isRecord(message) ? message.content : undefined;
    if (typeof content === "string") {
      texts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") texts.push(part.text);
    }
  }
  return texts.join("\n").trim();
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

/**
 * 失败原因归类。
 *
 * 余额不足是**用户能自己解决**的一类，必须和「服务挂了」分开说：
 * 前者引导去充值，后者让人以为产品坏了。判定规则与 PS 插件一致
 * （`sdpppx-services/src/store.ts`）：HTTP 402、`INSUFFICIENT_BALANCE`、
 * 报文里的「余额不足 / 积分不足 / insufficient balance」任一命中即可。
 */
export type FailureKind = "insufficient-balance" | "unauthorized" | "rate-limited" | "other";

export function classifyFailure(status: number, message: string): FailureKind {
  const text = message.toLowerCase();
  if (
    status === 402 ||
    text.includes("insufficient_balance") ||
    text.includes("insufficient balance") ||
    message.includes("余额不足") ||
    message.includes("积分不足")
  ) {
    return "insufficient-balance";
  }
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate-limited";
  return "other";
}

/** 给用户看的一句话。`insufficient-balance` 明确说「去充值」而不是「重试」。 */
export function failureMessage(kind: FailureKind, detail: string): string {
  switch (kind) {
    case "insufficient-balance":
      return "积分不足，请先充值后再生成";
    case "unauthorized":
      return "访问令牌无效或已过期，请在设置里重新填写";
    case "rate-limited":
      return "请求过于频繁，请稍后再试";
    case "other":
      return detail;
  }
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

/**
 * 从文本生成任务的结果里取出文本内容。
 *
 * language 模板的结果返回 `{ text: "..." }` 或类似结构，递归搜索 `text` / `content` / `output` 字段。
 */
export function readTextResult(payload: unknown): string {
  const visit = (node: unknown, depth: number): string | undefined => {
    if (depth > 6) return undefined;
    if (typeof node === "string" && node.trim()) return node.trim();
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return undefined;
    }
    if (!isRecord(node)) return undefined;
    for (const key of ["text", "content", "output", "result", "data"]) {
      if (key in node) {
        const found = visit(node[key], depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  };
  return visit(payload, 0) ?? "";
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
