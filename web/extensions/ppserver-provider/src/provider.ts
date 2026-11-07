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
import { isPassthroughTemplate, passthroughSource, passthroughTaskId, readPassthroughTaskId } from "./passthrough.js";
import {
  buildCreateStreamBody,
  buildTaskBody,
  classifyFailure,
  collectResultUrls,
  failureMessage,
  parseSseBuffer,
  readCost,
  readTextResult,
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
  /**
   * 取当前可用的令牌（含自动续期）。
   *
   * **是函数不是字符串**：令牌会在运行时被刷新替换，构造时拿一份注册进去，
   * 续期后仍在用旧值 —— 表现为「明明续期成功，请求还是 401」。
   */
  accessToken: string | (() => Promise<string> | string);
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
      // 令牌在请求头里由 auth() 现取，这里不交给 pptask 的配置层。
      ...(typeof options.accessToken === "string" ? { apiKey: options.accessToken } : {}),
      baseURL: options.baseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.jobRepository ? { jobRepository: options.jobRepository as never } : {}),
      ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {})
    },
    "",
    /*
     * `requireApiKey: false`。
     *
     * 令牌改成「每次请求现取」之后，构造期传进来的是函数而不是字符串，这时 apiKey 为空 ——
     * 默认的必填校验会在**扩展启动时**抛 `ppserver apiKey is required`，表现为插件直接加载失败、
     * 一个模型都注册不上（踩过）。令牌是否可用由请求期的 401/403 判定，不在这里拦。
     */
    false
  );
  if (!config.baseURL) throw new Error("ppserver 需要 baseURL");
  const origin = ppserverOrigin(config.baseURL);
  // 每次请求现取：续期会换掉令牌，构造时固定的话续期后仍用旧值。
  const resolveToken = async (): Promise<string> =>
    typeof options.accessToken === "function" ? (await options.accessToken()).trim() : options.accessToken.trim();
  const auth = async () => mergeHeaders({ authorization: `Bearer ${await resolveToken()}` });

  const protocol: HttpProviderProtocol = {
    providerId: PPSERVER_PROVIDER_ID,
    fetch: config.fetch,
    modelTypes: ["image", "video", "language"],
    mode: () => "async",
    validateModel(modelId, modelType) {
      const template = requireTemplate(options.catalog, modelId);
      if (template.kind !== modelType) {
        throw new Error(`ppserver 模板 ${modelId} 的类型是 ${template.kind}`);
      }
    },
    async start(context) {
      const template = requireTemplate(options.catalog, context.modelId);
      const templateId = template.templateId;
      if (isPassthroughTemplate(templateId)) {
        // 内部直通模板:不调 ppserver,图片地址直接编进任务 id(见 passthrough.ts)
        const source = passthroughSource(context.input);
        if (!source) throw new Error("直通模板缺少图片输入");
        const taskId = passthroughTaskId(source);
        return { operation: { taskId }, metadata: { taskId, templateId } };
      }
      const body = buildCreateStreamBody({
        templateId,
        payload: context.input,
        ...(options.tenantId ? { tenantId: options.tenantId } : {})
      });
      const jobId = await openStreamAndReadJobId({
        fetchImpl: config.fetch,
        url: `${origin}${PPSERVER_CREATE_STREAM_PATH}`,
        headers: mergeHeaders(await auth(), context.headers),
        body,
        ...(context.signal ? { signal: context.signal } : {}),
        timeoutMs: options.createTimeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS
      });
      return { operation: { taskId: jobId }, metadata: { taskId: jobId, templateId } };
    },
    async status(context) {
      const taskId = operationTaskId(context.operation);
      if (!taskId) return { state: "failed", error: "ppserver 任务缺少 taskId" };
      const passthrough = readPassthroughTaskId(taskId);
      if (passthrough !== undefined) {
        return { state: "completed", output: { data: [{ url: passthrough }], raw: {} }, metadata: { cost: 0 } };
      }

      const statusPayload = await postJson({
        fetchImpl: config.fetch,
        url: `${origin}${PPSERVER_STATUS_PATH}`,
        headers: mergeHeaders(await auth(), context.headers),
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
        headers: mergeHeaders(await auth(), context.headers),
        body: buildTaskBody({ taskId }),
        ...(context.signal ? { signal: context.signal } : {})
      });

      // language 模板返回文本，image/video 模板返回 URL 列表
      const template = requireTemplate(options.catalog, context.modelId);
      if (template.kind === "language") {
        const text = readTextResult(resultPayload);
        if (!text) {
          return { state: "failed", error: readTaskError(resultPayload) };
        }
        const cost = readCost(resultPayload);
        return {
          state: "completed",
          output: { text, raw: resultPayload },
          ...(cost !== undefined ? { metadata: { cost } } : {})
        };
      }

      const urls = collectResultUrls(resultPayload);
      if (urls.length === 0) {
        return { state: "failed", error: readTaskError(resultPayload) };
      }
      const cost = readCost(resultPayload);
      return {
        state: "completed",
        // 形状必须能被 `extractOutputValues` 走通：它只认 `data` / `result` / `url` 等键，
        // `urls` 不在其中（踩过：直接回 `{ urls }` 会报 "returned no image output"）。
        output: { data: urls.map((url) => ({ url })), raw: resultPayload },
        ...(cost !== undefined ? { metadata: { cost } } : {})
      };
    },
    async cancel(context) {
      const taskId = operationTaskId(context.operation);
      if (!taskId || readPassthroughTaskId(taskId) !== undefined) return;
      await postJson({
        fetchImpl: config.fetch,
        url: `${origin}${PPSERVER_CANCEL_PATH}`,
        headers: mergeHeaders(await auth(), context.headers),
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

/** 失败响应里能读到的说明；读不出来就空串（由 `failureMessage` 兜底）。 */
async function readFailureDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return "";
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      for (const key of ["error", "message", "msg"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value.trim().slice(0, 400);
        if (value && typeof value === "object" && typeof (value as Record<string, unknown>).message === "string") {
          return String((value as Record<string, unknown>).message).trim().slice(0, 400);
        }
      }
    }
  } catch {
    // 不是 JSON：原样截一段，至少能看出服务端说了什么。
  }
  return text.trim().slice(0, 400);
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
      // 402 / 令牌问题要给用户能照做的提示，而不是裸状态码。
      const detail = await readFailureDetail(response);
      const kind = classifyFailure(response.status, detail);
      throw new Error(failureMessage(kind, detail || `ppserver 创建任务失败（HTTP ${response.status}）`));
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
