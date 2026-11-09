/**
 * sdpppx 的任务提交：当前服务端只提供 `POST /tasks/create_stream`（SSE），没有
 * `POST /tasks/create`。提交后服务端先发 `created`（带 `job_id`），随后持续推送
 * `status` / `result`，并在终态发 `done`。
 *
 * 本模块只负责两件事：
 * - 拿到 `created` 就返回 `jobId`，让 operation 可以立刻建立；
 * - 继续在后台读完事件，把最新状态与最终结果存进内存，供 `doStatus` 读取，
 *   同时保持连接打开，避免服务端向已关闭的响应继续写。
 *
 * 事件只是加速与兜底：读流失败不把任务判死，`doStatus` 仍可回到
 * `/tasks/status` + `/tasks/result` 轮询。
 */

export type StreamedTask = {
  taskId: string;
  status: string;
  /** `result` 事件里的 result 值；未成功前为 null。 */
  outputs: unknown;
  /** 终态失败；`null` 表示没有失败。 */
  failureCode: string | null;
  /** 事件流不可用，`doStatus` 应回到轮询。 */
  streamError: boolean;
  /** 已收到 `done` 或到达流末尾。 */
  finished: boolean;
  touchedAt: number;
};

export type TaskStreamStartOptions = {
  fetchImpl: typeof globalThis.fetch;
  url: string;
  accessToken: string;
  tenantId: string;
  templateId: string;
  payload: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type TaskStreamTrackerOptions = {
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
};

export const TASK_STREAM_TIMEOUT_MS = 20_000;
const MAX_ERROR_BODY = 4 * 1024;
const STATE_TTL_MS = 60 * 60 * 1000;

export class CreateTaskError extends Error {
  readonly kind: "unauthorized" | "rejected" | "protocol" | "network";
  readonly status?: number;
  /** 服务端 `{ error }` 的稳定值，例如 `INSUFFICIENT_BALANCE`；只用于宿主日志。 */
  readonly reason?: string;

  constructor(kind: CreateTaskError["kind"], message: string, status?: number, reason?: string) {
    super(message);
    this.name = "CreateTaskError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
    if (reason !== undefined) this.reason = reason;
  }
}

export type SseEvent = { event: string; data: unknown };

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** 解析一个 SSE 块；数据不是 JSON 时返回 null（例如代理注入的注释）。 */
export function parseSseBlock(block: string): SseEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) as unknown };
  } catch {
    return null;
  }
}

function applyEvent(task: StreamedTask, event: SseEvent): void {
  const data = recordOf(event.data) ?? {};
  if (event.event === "created") {
    const created = textOf(data.job_id) ?? textOf(data.taskId) ?? textOf(data.task_id);
    if (created && !task.taskId) task.taskId = created;
    const status = textOf(data.status);
    if (status) task.status = status;
    return;
  }
  if (event.event === "status") {
    const status = textOf(data.status);
    if (status) task.status = status;
    return;
  }
  if (event.event === "result") {
    task.status = textOf(data.status) ?? "succeeded";
    if (data.result !== undefined) task.outputs = data.result;
    return;
  }
  if (event.event === "error") {
    if (textOf(data.status) === "failed") {
      task.status = "failed";
      task.failureCode = "sdpppx-task-failed";
    } else {
      // 服务端轮询超时或代理断流：不把任务判死，回落到 /tasks/status。
      task.streamError = true;
    }
    return;
  }
  if (event.event === "done") task.finished = true;
}

type ReaderState = { buffer: string; decoder: TextDecoder };

function drainBuffer(state: ReaderState): SseEvent[] {
  const events: SseEvent[] = [];
  let index = state.buffer.indexOf("\n\n");
  while (index >= 0) {
    const event = parseSseBlock(state.buffer.slice(0, index));
    state.buffer = state.buffer.slice(index + 2);
    if (event) events.push(event);
    index = state.buffer.indexOf("\n\n");
  }
  return events;
}

async function nextChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: ReaderState
): Promise<{ done: boolean; events: SseEvent[] }> {
  const chunk = await reader.read();
  if (chunk.done) {
    state.buffer += state.decoder.decode();
    return { done: true, events: drainBuffer(state) };
  }
  state.buffer += state.decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
  return { done: false, events: drainBuffer(state) };
}

async function continueReading(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: ReaderState,
  task: StreamedTask,
  now: () => number,
  log: (event: Record<string, unknown>) => void
): Promise<void> {
  try {
    for (;;) {
      const chunk = await nextChunk(reader, state);
      for (const event of chunk.events) applyEvent(task, event);
      task.touchedAt = now();
      if (chunk.done) {
        task.finished = true;
        if (!task.outputs && !task.failureCode && !task.streamError) task.streamError = true;
        break;
      }
    }
  } catch (error) {
    task.streamError = true;
    log({ event: "sdpppx-task-stream-failed", reason: error instanceof Error ? error.name : "unknown" });
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 已关闭的连接无需处理。
    }
  }
}

async function readResponseError(response: Response): Promise<string | undefined> {
  try {
    const text = (await response.text()).slice(0, MAX_ERROR_BODY);
    return textOf(recordOf(JSON.parse(text) as unknown)?.error);
  } catch {
    return undefined;
  }
}

function errorMessageOf(status: number): string {
  if (status === 401 || status === 403) return "登录已过期";
  if (status === 402) return "账户余额不足";
  if (status === 404) return "模板不存在或已停用";
  if (status === 400) return "任务参数无效";
  return "SDPPPX 服务暂不可用";
}

export function createTaskStreamTracker(options: TaskStreamTrackerOptions = {}) {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const tasks = new Map<string, StreamedTask>();

  function prune(): void {
    const cutoff = now() - STATE_TTL_MS;
    for (const [taskId, task] of tasks) {
      if (task.touchedAt < cutoff) tasks.delete(taskId);
    }
  }

  async function start(input: TaskStreamStartOptions): Promise<{ taskId: string }> {
    prune();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, input.timeoutMs ?? TASK_STREAM_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    if (input.signal) {
      if (input.signal.aborted) controller.abort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      let response: Response;
      try {
        response = await input.fetchImpl(input.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${input.accessToken}`,
            Accept: "text/event-stream",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            tenantId: input.tenantId,
            templateId: input.templateId,
            payload: input.payload
          }),
          signal: controller.signal
        });
      } catch {
        throw new CreateTaskError("network", timedOut ? "SDPPPX 请求超时" : "SDPPPX 服务暂不可用");
      }
      if (response.status === 401 || response.status === 403) {
        throw new CreateTaskError("unauthorized", errorMessageOf(response.status), response.status);
      }
      if (!response.ok) {
        const reason = await readResponseError(response);
        throw new CreateTaskError("rejected", errorMessageOf(response.status), response.status, reason);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream") || !response.body) {
        throw new CreateTaskError("protocol", "SDPPPX 未返回任务事件流", response.status);
      }

      const reader = response.body.getReader();
      const state: ReaderState = { buffer: "", decoder: new TextDecoder() };
      const task: StreamedTask = {
        taskId: "",
        status: "queued",
        outputs: null,
        failureCode: null,
        streamError: false,
        finished: false,
        touchedAt: now()
      };
      try {
        while (!task.taskId && !task.failureCode && !task.streamError) {
          const chunk = await nextChunk(reader, state);
          for (const event of chunk.events) applyEvent(task, event);
          if (chunk.done) break;
        }
      } catch {
        task.streamError = true;
      }
      if (!task.taskId) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        throw new CreateTaskError("protocol", "SDPPPX 未返回任务 ID", response.status);
      }
      tasks.set(task.taskId, task);
      void continueReading(reader, state, task, now, log);
      return { taskId: task.taskId };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  function lookup(taskId: string): StreamedTask | undefined {
    return tasks.get(taskId);
  }

  function clear(): void {
    tasks.clear();
  }

  return { start, lookup, clear };
}

export type TaskStreamTracker = ReturnType<typeof createTaskStreamTracker>;
