/**
 * Replicate 预测执行。
 *
 * 官方与社区模型都用 `POST /predictions`，version 写成 `owner/name:version`。
 * 图片在插件内带 Token 下载成字节，避免结果地址再被没有 Token 的转存请求访问。
 * 视频仍交回 URL：任务运行时只按地址转存大视频。
 */
import type { PptaskDescription, PptaskModelType, PptaskProvider } from "@sdppp/pptask";
import { bytesToBase64, createHttpProvider, jsonRequest, mergeHeaders, requestJson } from "@sdppp/pptask/providers/shared";
import { buildPredictionInput, type ReplicateModel } from "./schema.js";
import { REPLICATE_PROVIDER_ID, replicateOrigin } from "./shared.js";

export type ReplicateCatalog = { models: ReplicateModel[] };

export type ReplicateProviderOptions = {
  apiKey: string;
  baseURL: string;
  catalog: ReplicateCatalog;
  fetch?: typeof globalThis.fetch;
  jobRepository?: unknown;
  pollIntervalMs?: number;
};

type Prediction = {
  id?: string;
  status?: string;
  output?: unknown;
  error?: unknown;
  metrics?: { progress?: unknown };
};

export function createReplicateProvider(options: ReplicateProviderOptions): PptaskProvider {
  const apiKey = options.apiKey.trim();
  const baseURL = replicateOrigin(options.baseURL);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!apiKey) throw new Error("Replicate 需要 API Token");
  if (!baseURL) throw new Error("Replicate 需要 baseURL");
  if (!fetchImpl) throw new Error("Replicate 需要 fetch");

  return createHttpProvider({
    providerId: REPLICATE_PROVIDER_ID,
    fetch: fetchImpl,
    modelTypes: ["language", "image", "video", "audio"],
    mode: () => "async",
    validateModel(modelId, modelType) {
      const model = findModel(options.catalog, modelId);
      if (model.modelType !== modelType) throw new Error(`Replicate 模型 ${modelId} 的类型是 ${model.modelType}`);
    },
    async start(context) {
      const model = findModel(options.catalog, context.modelId);
      const input = buildPredictionInput(context.input, model);
      const prediction = await requestJson<Prediction>(
        fetchImpl,
        REPLICATE_PROVIDER_ID,
        jsonRequest(`${baseURL}/predictions`, {
          version: `${model.id}:${model.version}`,
          input
        }, authHeaders(apiKey, context.headers)),
        context.signal
      );
      if (!prediction.id) throw new Error("Replicate 未返回 prediction id");
      return { operation: { predictionId: prediction.id } };
    },
    async status(context) {
      const model = findModel(options.catalog, context.modelId);
      const prediction = await requestJson<Prediction>(
        fetchImpl,
        REPLICATE_PROVIDER_ID,
        {
          url: `${baseURL}/predictions/${encodeURIComponent(predictionId(context.operation))}`,
          method: "GET",
          headers: authHeaders(apiKey, context.headers)
        },
        context.signal
      );
      if (prediction.status === "succeeded") {
        return { state: "completed", output: await completedOutput(model, prediction, fetchImpl, context.signal) };
      }
      if (prediction.status === "failed" || prediction.status === "canceled") {
        return { state: "failed", error: predictionError(prediction) };
      }
      return {
        state: "pending",
        phase: prediction.status === "processing" ? "running" : "queued",
        ...(progressOf(prediction) !== undefined ? { progress: progressOf(prediction) } : {})
      };
    },
    async cancel(context) {
      await requestJson(
        fetchImpl,
        REPLICATE_PROVIDER_ID,
        {
          url: `${baseURL}/predictions/${encodeURIComponent(predictionId(context.operation))}/cancel`,
          method: "POST",
          headers: authHeaders(apiKey, context.headers)
        },
        context.signal
      );
    },
    describe: async (modelId, modelType) => describeReplicateModel(findModel(options.catalog, modelId), modelType)
  }, {
    apiKey,
    baseURL,
    fetch: fetchImpl,
    ...(options.jobRepository ? { jobRepository: options.jobRepository as never } : {}),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {})
  });
}

export function describeReplicateModel(model: ReplicateModel, modelType: PptaskModelType): PptaskDescription {
  return {
    providerId: REPLICATE_PROVIDER_ID,
    modelId: model.id,
    modelType,
    title: model.title,
    inputSchema: model.inputSchema,
    defaultInput: model.defaultInput,
    capabilities: { cancel: true, operation: "prediction" }
  };
}

async function completedOutput(
  model: ReplicateModel,
  prediction: Prediction,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal
): Promise<unknown> {
  if (model.modelType === "language") return { text: predictionText(prediction.output) };
  const urls = outputUrls(prediction.output);
  if (urls.length === 0) throw new Error("Replicate 没有返回输出文件");
  if (model.modelType === "image") {
    const images = await Promise.all(urls.map((url) => downloadImage(fetchImpl, url, signal)));
    return { data: images.map((image) => ({ b64_json: image.b64, mimeType: image.mediaType })) };
  }
  return { data: urls.map((url) => ({ url })) };
}

async function downloadImage(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  signal?: AbortSignal
): Promise<{ b64: string; mediaType: string }> {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new Error(`下载 Replicate 图片失败（HTTP ${response.status}）`);
  const mediaType = (response.headers.get("content-type") ?? "image/png").split(";")[0]?.trim().toLowerCase() || "image/png";
  return { b64: bytesToBase64(new Uint8Array(await response.arrayBuffer())), mediaType };
}

function predictionText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const parts = output.filter((item): item is string => typeof item === "string");
    if (parts.length > 0) return parts.join("");
  }
  if (isRecord(output) && typeof output.text === "string") return output.text;
  throw new Error("Replicate 没有返回文本");
}

function outputUrls(output: unknown): string[] {
  if (typeof output === "string" && /^https?:\/\//i.test(output)) return [output];
  if (Array.isArray(output)) return output.flatMap(outputUrls);
  if (isRecord(output)) {
    for (const key of ["url", "video", "image", "output"]) {
      if (key in output) {
        const urls = outputUrls(output[key]);
        if (urls.length > 0) return urls;
      }
    }
  }
  return [];
}

function predictionError(prediction: Prediction): string {
  if (prediction.status === "canceled") return "Replicate 预测已取消";
  if (typeof prediction.error === "string" && prediction.error.trim()) return prediction.error.trim().slice(0, 400);
  if (prediction.error) return JSON.stringify(prediction.error).slice(0, 400);
  return `Replicate 预测结束于 ${prediction.status ?? "unknown"}`;
}

function progressOf(prediction: Prediction): number | undefined {
  const value = prediction.metrics?.progress;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value <= 1 ? Math.round(value * 100) : value;
}

function predictionId(operation: unknown): string {
  if (isRecord(operation) && typeof operation.predictionId === "string" && operation.predictionId) return operation.predictionId;
  throw new Error("Replicate 任务缺少 prediction id");
}

function findModel(catalog: ReplicateCatalog, modelId: string): ReplicateModel {
  const model = catalog.models.find((item) => item.id === modelId);
  if (!model) throw new Error(`Replicate 模型未登记：${modelId}`);
  return model;
}

function authHeaders(apiKey: string, extra?: Record<string, string | undefined>): Record<string, string> {
  return mergeHeaders({ authorization: `Bearer ${apiKey}`, accept: "application/json" }, extra);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
