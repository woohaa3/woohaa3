/**
 * ppserver 执行。
 *
 * 创建走 SSE（`/tasks/create_stream`）：流的第一条 `created` 事件就是 `job_id`，
 * 拿到之后**主动断开流**，改由 `/tasks/status` + `/tasks/result` 轮询。
 *
 * 为什么不在流里等到底：宿主按「durable job」模型驱动 Provider（`start` / `status` /
 * `cancel`），任务要能在刷新后接着查；把结果绑在一条长连接上就做不到。PS 插件也是
 * 「SSE 断开 → 降级轮询」，这里直接以轮询为准，SSE 只用来取 id。
 */
import type { PptaskDescription, PptaskModelType, PptaskProvider } from "@sdppp/pptask";
import {
  createHttpProvider,
  mergeHeaders,
  normalizeProviderConfig,
  type HttpProviderProtocol
} from "@sdppp/pptask/providers/shared";
import {
  buildCreateStreamBody,
  buildTaskBody,
  collectResultUrls,
  parseSseBuffer,
  readCost,
  readJobId,
  readProgress,
  readTaskError,
  readTaskState
} from "./protocol.js";
import type { PpserverTemplate } from "./discovery.js";
import {
  PPSERVER_CANCEL_PATH,
  PPSERVER_CREATE_STREAM_PATH,
  PPSERVER_PROVIDER_ID,
  PPSERVER_RESULT_PATH,
  PPSERVER_STATUS_PATH,
  ppserverOrigin
} from "./shared.js";

export type PpserverCatalog = { templates: PpserverTemplate[] };

export type PpserverProviderOptions = {
  /** ppserver 的 Bearer 令牌（Supabase access_token）。 */
  accessToken: string;
  baseUrl: string;
  catalog: PpserverCatalog;
  /** 租户：服务端按它计费与筛选模板。 */
  tenantId?: string;
  fetch?: typeof globalThis.fetch;
  jobRepository?: unknown;
  pollIntervalMs?: number;
  /** 等 `created` 事件的上限；超时就当成创建失败，避免挂住整个任务。 */
  createTimeoutMs?: number;
};

const DEFAULT_CREATE_TIMEOUT_MS = 30_000;

export function createPpserverProvider(options: PpserverProviderOptions): PptaskProvider {
  const config = normalizeProviderConfig(
    PPSERVER_PROVIDER_ID,
    {
      apiKey: options.accessToken,
      baseURL: options.baseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.jobRepository ? { jobRepository: options.jobRepository as never } : {}),
      ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {})
    },
    ""
  );
  if (!config.baseURL) throw new Error("ppserver 需要 baseURL");
  const origin = ppserverOrigin(config.baseURL);
  const auth = () => mergeHeaders({ authorization: `Bearer ${config.apiKey ?? ""}` });

  const protocol: HttpProviderProtocol = {
    providerId: PPSERVER_PROVIDER_ID,
    fetch: config.fetch,
    modelTypes: ["image", "video"],
    mode: () => "async",
    validateModel(modelId, modelType) {
      const template = requireTemplate(options.catalog, modelId);
      if (template.kind !== modelType) {
        throw new Error(`ppserver 模板 ${modelId} 的类型是 ${template.kind}`);
      }
    },
    async start(context) {
      const templateId = requireTemplate(options.catalog, context.modelId).templateId;
      const body = buildCreateStreamBody({
        templateId,
        payload: context.input,
        ...(options.tenantId ? { tenantId: options.tenantId } : {})
      });
      const jobId = await openStreamAndReadJobId({
        fetchImpl: config.fetch,
        url: `${origin}${PPSERVER_CREATE_STREAM_PATH}`,
        headers: mergeHeaders(auth(), context.headers),
        body,
        ...(context.signal ? { signal: context.signal } : {}),
        timeoutMs: options.createTimeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS
      });
      return { operation: { taskId: jobId }, metadata: { taskId: jobId, templateId } };
    },
    async status(context) {
      const taskId = operationTaskId(context.operation);
      if (!taskId) return { state: "failed", error: "ppserver 任务缺少 taskId" };

      const statusPayload = await postJson({
        fetchImpl: config.fetch,
        url: `${origin}${PPSERVER_STATUS_PATH}`,
        headers: mergeHeaders(auth(), context.headers),
        body: buildTaskBody({ taskId }),
        ...(context.signal ? { signal: context.signal } : {})
      });
      const state = readTaskState(statusPayload);
      if (state === "failed") return { state: "failed", error: readTaskError(statusPayload) };
      if (state === "cancelled") return { state: "failed", error: "ppserver 任务已取消" };
      if (state !== "succeeded") {
        const progress = readProgress(statusPayload);
        return {
          state: "pending",
          phase: state === "running" ? "running" : "queued",
          ...(progress !== undefined ? { progress } : {})
        };
      }

      // 结果单独一次请求：status 只说成败，不保证带产物。
      const resultPayload = await postJson({
        fetchImpl: config.fetch,
        url: `${origin}${PPSERVER_RESULT_PATH}`,
        headers: mergeHeaders(auth(), context.headers),
        body: buildTaskBody({ taskId }),
        ...(context.signal ? { signal: context.signal } : {})
      });
      const urls = collectResultUrls(resultPayload);
      if (urls.length === 0) {
        return { state: "failed", error: readTaskError(resultPayload) };
      }
      const cost = readCost(resultPayload);
      return {
        state: "completed",
        output: { urls, raw: resultPayload },
        ...(cost !== undefined ? { metadata: { cost } } : {})
      };
    },
    async cancel(context) {
      const taskId = operationTaskId(context.operation);
      if (!taskId) return;
      await postJson({
        fetchImpl: config.fetch,
        url: `${origin}${PPSERVER_CANCEL_PATH}`,
        headers: mergeHeaders(auth(), context.headers),
        body: buildTaskBody({ taskId }),
        ...(context.signal ? { signal: context.signal } : {})
      });
    },
    describe: async (modelId, modelType) =>
      describeTemplate(requireTemplate(options.catalog, modelId), modelType)
  };

  return createHttpProvider(protocol, {
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    fetch: config.fetch,
    ...(options.jobRepository ? { jobRepository: options.jobRepository as never } : {}),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {})
  });
}

export function describeTemplate(template: PpserverTemplate, modelType: PptaskModelType): PptaskDescription {
  return {
    providerId: PPSERVER_PROVIDER_ID,
    modelId: template.modelId,
    modelType,
    title: template.title,
    // 取消走服务端的 `/tasks/cancel`，不是只停本地轮询。
    capabilities: { cancel: true, operation: "job" }
  };
}

/**
 * 发创建请求，读到 `created` 事件就断开。
 *
 * 用 `AbortController` 主动掐流：只要拿到 job id，后续连接就是浪费（而且挂着会占宿主
 * 的并发）。读不到就按创建失败处理 —— 没有 id 的任务没法轮询，也没有东西可取消。
 */
async function openStreamAndReadJobId(input: {
  fetchImpl: typeof globalThis.fetch;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  const abortOuter = () => controller.abort();
  input.signal?.addEventListener("abort", abortOuter, { once: true });
  try {
    const response = await input.fetchImpl(input.url, {
      method: "POST",
      headers: { ...input.headers, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(input.body),
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`ppserver 创建任务失败（HTTP ${response.status}）`);
    }
    if (!response.body) {
      // 有的部署直接回 JSON 而不是流。
      const payload = (await response.json()) as unknown;
      const id = readJobId(payload);
      if (!id) throw new Error("ppserver 创建任务没有返回 job_id");
      return id;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, remainder } = parseSseBuffer(buffer);
        buffer = remainder;
        for (const event of events) {
          if (event.type === "created") {
            const id = readJobId(event.data);
            if (id) return id;
          }
          if (event.type === "error") throw new Error(readTaskError(event.data));
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    // 流结束了还没见到 created：有些部署把 job id 放在最后一条事件里。
    for (const event of parseSseBuffer(`${buffer}\n\n`).events) {
      const id = readJobId(event.data);
      if (id) return id;
    }
    throw new Error("ppserver 创建任务的流已结束，但没有返回 job_id");
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abortOuter);
    controller.abort();
  }
}

async function postJson(input: {
  fetchImpl: typeof globalThis.fetch;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<unknown> {
  const response = await input.fetchImpl(input.url, {
    method: "POST",
    headers: { ...input.headers, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input.body),
    ...(input.signal ? { signal: input.signal } : {})
  });
  if (!response.ok) {
    throw new Error(`ppserver 请求失败（HTTP ${response.status}）`);
  }
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("ppserver 返回的不是合法 JSON");
  }
}

function operationTaskId(operation: unknown): string {
  const record = operation && typeof operation === "object" && !Array.isArray(operation) ? (operation as Record<string, unknown>) : {};
  return typeof record.taskId === "string" ? record.taskId.trim() : "";
}

function requireTemplate(catalog: PpserverCatalog, modelId: string): PpserverTemplate {
  const template = catalog.templates.find((item) => item.modelId === modelId);
  if (!template) throw new Error(`ppserver 模板未登记：${modelId}`);
  return template;
}
