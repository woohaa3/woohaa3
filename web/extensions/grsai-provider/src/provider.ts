/**
 * grsai 执行。
 *
 * 图片与视频走统一生成接口：`POST /v1/api/generate`（`replyType: "async"`）拿任务 id，
 * 再 `GET /v1/api/result?id=...` 轮询；文本走 OpenAI 兼容的 `POST /v1/chat/completions`（同步）。
 * 图片输出交给共享实现下载成字节（走受控 fetch），视频只交回地址。
 */
import type { PptaskDescription, PptaskModelType, PptaskProvider } from "@sdppp/pptask";
import {
  createHttpProvider,
  mergeHeaders,
  normalizeProviderConfig,
  type HttpProviderProtocol
} from "@sdppp/pptask/providers/shared";
import type { GrsaiModel } from "./discovery.js";
import { grsaiErrorMessage, grsaiTaskId, interpretGrsaiResult } from "./result.js";
import { buildChatBody, buildGenerateBody } from "./schema.js";
import {
  GRSAI_CHAT_PATH,
  GRSAI_GENERATE_PATH,
  GRSAI_PROVIDER_ID,
  GRSAI_RESULT_PATH,
  grsaiOrigin
} from "./shared.js";
import { GrsaiHttpError, requestGrsai } from "./transport.js";

export type GrsaiCatalog = { models: GrsaiModel[] };

export type GrsaiProviderOptions = {
  apiKey: string;
  baseURL: string;
  catalog: GrsaiCatalog;
  fetch?: typeof globalThis.fetch;
  jobRepository?: unknown;
  pollIntervalMs?: number;
};

export function createGrsaiProvider(options: GrsaiProviderOptions): PptaskProvider {
  const config = normalizeProviderConfig(GRSAI_PROVIDER_ID, {
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.jobRepository ? { jobRepository: options.jobRepository as never } : {}),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {})
  }, "");
  if (!config.baseURL) throw new Error("grsai 需要 baseURL");
  const origin = grsaiOrigin(config.baseURL);
  const auth = () => mergeHeaders({ authorization: `Bearer ${config.apiKey ?? ""}` });

  const protocol: HttpProviderProtocol = {
    providerId: GRSAI_PROVIDER_ID,
    fetch: config.fetch,
    modelTypes: ["image", "video", "language"],
    mode(modelId) {
      return requireModel(options.catalog, modelId).kind === "language" ? "sync" : "async";
    },
    validateModel(modelId, modelType) {
      const model = requireModel(options.catalog, modelId);
      if (model.kind !== modelType) throw new Error(`grsai 模型 ${modelId} 的类型是 ${model.kind}`);
    },
    async execute(context) {
      const model = requireModel(options.catalog, context.modelId);
      const payload = await requestGrsai({
        fetchImpl: config.fetch,
        providerId: GRSAI_PROVIDER_ID,
        method: "POST",
        url: `${origin}${GRSAI_CHAT_PATH}`,
        body: buildChatBody(model, context.input),
        headers: mergeHeaders(auth(), context.headers),
        ...(context.signal ? { signal: context.signal } : {})
      });
      const error = grsaiErrorMessage(payload);
      if (error) throw new Error(error);
      return payload;
    },
    async start(context) {
      const model = requireModel(options.catalog, context.modelId);
      const payload = await requestGrsai({
        fetchImpl: config.fetch,
        providerId: GRSAI_PROVIDER_ID,
        method: "POST",
        url: `${origin}${GRSAI_GENERATE_PATH}`,
        body: buildGenerateBody(model, context.input),
        headers: mergeHeaders(auth(), context.headers),
        ...(context.signal ? { signal: context.signal } : {})
      });
      const error = grsaiErrorMessage(payload);
      if (error) throw new Error(error);
      const taskId = grsaiTaskId(payload);
      if (!taskId) throw new Error("grsai 未返回任务 ID");
      return { operation: { taskId } };
    },
    async status(context) {
      const taskId = operationId(context.operation);
      if (!taskId) return { state: "failed", error: "grsai 任务缺少 task id" };
      let payload: unknown;
      try {
        payload = await requestGrsai({
          fetchImpl: config.fetch,
          providerId: GRSAI_PROVIDER_ID,
          method: "GET",
          url: `${origin}${GRSAI_RESULT_PATH}?id=${encodeURIComponent(taskId)}`,
          headers: mergeHeaders(auth(), context.headers),
          ...(context.signal ? { signal: context.signal } : {})
        });
      } catch (error) {
        // 任务结果只保留 2 小时；查不到就是过期或不存在，直接按失败收口。
        if (error instanceof GrsaiHttpError && error.status === 404) return { state: "failed", error: error.message };
        throw error;
      }
      const error = grsaiErrorMessage(payload);
      if (error) return { state: "failed", error };
      const view = interpretGrsaiResult(payload);
      if (view.state === "pending") {
        return { state: "pending", phase: view.phase, ...(view.progress !== undefined ? { progress: view.progress } : {}) };
      }
      if (view.state === "failed") return { state: "failed", error: view.error };
      const model = options.catalog.models.find((item) => item.id === context.modelId);
      if (model?.kind === "video") return { state: "completed", output: { videos: view.urls.map((url) => ({ url })) } };
      return { state: "completed", output: { data: view.urls.map((url) => ({ url })) } };
    },
    describe: async (modelId, modelType) => describeGrsaiModel(requireModel(options.catalog, modelId), modelType)
  };

  return createHttpProvider(protocol, {
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    fetch: config.fetch,
    ...(options.jobRepository ? { jobRepository: options.jobRepository as never } : {}),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {})
  });
}

export function describeGrsaiModel(model: GrsaiModel, modelType: PptaskModelType): PptaskDescription {
  return {
    providerId: GRSAI_PROVIDER_ID,
    modelId: model.id,
    modelType,
    title: model.title,
    capabilities: { cancel: false, operation: "job" }
  };
}

function operationId(operation: unknown): string {
  const record = operation && typeof operation === "object" && !Array.isArray(operation) ? (operation as Record<string, unknown>) : {};
  return typeof record.taskId === "string" ? record.taskId.trim() : "";
}

function requireModel(catalog: GrsaiCatalog, modelId: string): GrsaiModel {
  const model = catalog.models.find((item) => item.id === modelId);
  if (!model) throw new Error(`grsai 模型未登记：${modelId}`);
  return model;
}
