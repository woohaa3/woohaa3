/**
 * fal 队列执行。
 *
 * 提交 `POST {origin}/{endpointId}`（body 就是模型输入），轮询 `GET .../requests/{id}/status`，
 * 完成后取 `GET .../requests/{id}`。图片按共享实现下载成字节（走受控 fetch），视频只交回地址，
 * 文本统一收成 `{ text }`，避免上游 `output` 字段被当成 JSON 串。
 */
import type { PptaskDescription, PptaskModelType, PptaskProvider } from "@sdppp/pptask";
import { createHttpProvider, jsonRequest, mergeHeaders, requestJson } from "@sdppp/pptask/providers/shared";
import { buildFalInput, type FalModel } from "./schema.js";
import { FAL_PROVIDER_ID, falOrigin } from "./shared.js";

export type FalCatalog = { models: FalModel[] };

export type FalProviderOptions = {
  apiKey: string;
  baseURL: string;
  catalog: FalCatalog;
  fetch?: typeof globalThis.fetch;
  jobRepository?: unknown;
  pollIntervalMs?: number;
};

type QueueSubmit = { request_id?: unknown };
type QueueState = { status?: unknown; error?: unknown; error_type?: unknown; queue_position?: unknown };

export function createFalProvider(options: FalProviderOptions): PptaskProvider {
  const apiKey = options.apiKey.trim();
  const baseURL = falOrigin(options.baseURL);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!apiKey) throw new Error("fal 需要 API Key");
  if (!baseURL) throw new Error("fal 需要 baseURL");
  if (!fetchImpl) throw new Error("fal 需要 fetch");

  return createHttpProvider({
    providerId: FAL_PROVIDER_ID,
    fetch: fetchImpl,
    modelTypes: ["language", "image", "video", "audio"],
    mode: () => "async",
    validateModel(modelId, modelType) {
      const model = findModel(options.catalog, modelId);
      if (model.modelType !== modelType) throw new Error(`fal 模型 ${modelId} 的类型是 ${model.modelType}`);
    },
    async start(context) {
      const model = findModel(options.catalog, context.modelId);
      const input = buildFalInput(context.input, model);
      const submitted = await requestJson<QueueSubmit>(
        fetchImpl,
        FAL_PROVIDER_ID,
        jsonRequest(`${baseURL}/${model.id}`, input, authHeaders(apiKey, context.headers)),
        context.signal
      );
      const requestId = typeof submitted.request_id === "string" ? submitted.request_id.trim() : "";
      if (!requestId) throw new Error("fal 未返回 request id");
      return { operation: { requestId, endpointId: model.id } };
    },
    async status(context) {
      const operation = operationOf(context.operation);
      const model = findModel(options.catalog, operation.endpointId || context.modelId);
      if (!operation.requestId) return { state: "failed", error: "fal 任务缺少 request id" };
      const requestId = operation.requestId;
      const state = await requestJson<QueueState>(
        fetchImpl,
        FAL_PROVIDER_ID,
        {
          url: `${baseURL}/${model.id}/requests/${encodeURIComponent(requestId)}/status`,
          method: "GET",
          headers: authHeaders(apiKey, context.headers)
        },
        context.signal
      );
      const status = typeof state.status === "string" ? state.status.toUpperCase() : "";
      if (status === "COMPLETED") {
        if (state.error !== undefined && state.error !== null) return { state: "failed", error: failureMessage(state) };
        const result = await requestJson<unknown>(
          fetchImpl,
          FAL_PROVIDER_ID,
          {
            url: `${baseURL}/${model.id}/requests/${encodeURIComponent(requestId)}`,
            method: "GET",
            headers: authHeaders(apiKey, context.headers)
          },
          context.signal
        );
        return { state: "completed", output: completedOutput(model, result) };
      }
      return { state: "pending", phase: status === "IN_PROGRESS" ? "running" : "queued" };
    },
    async cancel(context) {
      const operation = operationOf(context.operation);
      if (!operation.requestId) return;
      const endpointId = operation.endpointId || context.modelId;
      const response = await fetchImpl(`${baseURL}/${endpointId}/requests/${encodeURIComponent(operation.requestId)}/cancel`, {
        method: "PUT",
        headers: authHeaders(apiKey, context.headers),
        signal: context.signal
      });
      // 已经结束（400）或找不到（404）都视为取消到位；只有其它错误才上报。
      if (!response.ok && ![400, 404, 409].includes(response.status)) {
        const body = await response.text().catch(() => "");
        throw new Error(`fal 取消失败（HTTP ${response.status}）：${body.slice(0, 200)}`);
      }
    },
    describe: async (modelId, modelType) => describeFalModel(findModel(options.catalog, modelId), modelType)
  }, {
    apiKey,
    baseURL,
    fetch: fetchImpl,
    ...(options.jobRepository ? { jobRepository: options.jobRepository as never } : {}),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {})
  });
}

export function describeFalModel(model: FalModel, modelType: PptaskModelType): PptaskDescription {
  return {
    providerId: FAL_PROVIDER_ID,
    modelId: model.id,
    modelType,
    title: model.title,
    inputSchema: model.inputSchema,
    defaultInput: model.defaultInput,
    capabilities: { cancel: true, operation: "queue" }
  };
}

/** 文本收成 `{ text }`；视频收成 `{ videos: [{ url }] }`；图片与音频交给共享输出解析。 */
export function completedOutput(model: FalModel, result: unknown): unknown {
  if (model.modelType === "language") return { text: outputText(result) };
  if (model.modelType === "video") {
    const urls = videoUrls(result);
    if (urls.length === 0) throw new Error("fal 没有返回视频");
    return { videos: urls.map((url) => ({ url })) };
  }
  return result;
}

function outputText(result: unknown): string {
  if (typeof result === "string") return result;
  if (isRecord(result)) {
    if (typeof result.output === "string") return result.output;
    if (typeof result.text === "string") return result.text;
    if (isRecord(result.output) && typeof result.output.text === "string") return result.output.text;
  }
  throw new Error("fal 没有返回文本");
}

function videoUrls(result: unknown): string[] {
  if (!isRecord(result)) return [];
  const direct = isRecord(result.video) ? result.video.url : undefined;
  if (typeof direct === "string") return [direct];
  if (typeof result.video_url === "string") return [result.video_url];
  if (Array.isArray(result.videos)) {
    return result.videos.flatMap((item) => (isRecord(item) && typeof item.url === "string" ? [item.url] : typeof item === "string" ? [item] : []));
  }
  return [];
}

function failureMessage(state: QueueState): string {
  if (typeof state.error === "string" && state.error.trim()) return state.error.trim().slice(0, 400);
  if (state.error !== undefined && state.error !== null) return JSON.stringify(state.error).slice(0, 400);
  const type = typeof state.error_type === "string" ? state.error_type.trim() : "";
  return type ? `fal 任务失败（${type}）` : "fal 任务失败";
}

function operationOf(operation: unknown): { requestId: string; endpointId: string } {
  const record = isRecord(operation) ? operation : {};
  return {
    requestId: typeof record.requestId === "string" ? record.requestId : "",
    endpointId: typeof record.endpointId === "string" ? record.endpointId : ""
  };
}

function findModel(catalog: FalCatalog, modelId: string): FalModel {
  const model = catalog.models.find((item) => item.id === modelId);
  if (!model) throw new Error(`fal 模型未登记：${modelId}`);
  return model;
}

function authHeaders(apiKey: string, extra?: Record<string, string | undefined>): Record<string, string> {
  return mergeHeaders({ authorization: `Key ${apiKey}`, accept: "application/json" }, extra);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
