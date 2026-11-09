/**
 * sdpppx 生成 Provider。
 *
 * 用 `@sdppp/pptask` 的 `createPptaskProvider` + 显式 image/video 模型实现，而不是
 * `createHttpProvider`：模板 payload 是**不透明**的（字段名由租户模板决定），
 * `doStart` 必须原样收到 `prepareInput` 组装好的对象；同时每次请求都要注入当前会话令牌，
 * 结果映射也要按模型类型分别处理（图片下载字节、视频保留 URL）。
 *
 * 职责边界：
 * - 本文件只做「模板任务 ↔ pptask operation」的翻译；
 * - 会话刷新、401 清会话、目录与 describe 缓存由调用方提供；
 * - 参考素材的上传与允许名单在 `reference.ts`，这里只校验位置并写回 payload。
 */
import { createPptaskProvider } from "@sdppp/pptask";
import type {
  PptaskImageModelImplementation,
  PptaskModel,
  PptaskProvider,
  PptaskVideoModelImplementation
} from "@sdppp/pptask";
import type { GenerationModelDescription, GenerationPrepareInput } from "@woohaa3/contracts";
import type { SdpppxConfig } from "./config.js";
import { buildSdpppxInputSchema, type SdpppxInputSchema } from "./schema.js";
import { SDPPPX_PROVIDER_ID } from "../shared.js";
import type { SessionManager } from "./session.js";
import type { SdpppxReferenceUploader } from "./reference.js";
import type { SdpppxTemplate } from "./catalog.js";
import {
  SdpppxProviderError,
  buildSdpppxPayload,
  downloadImages,
  isRecord,
  outputUrlsOf,
  stableMessage,
  textOf,
  videoMediaTypeOf,
  type RecordValue
} from "./provider-support.js";
import { CreateTaskError, createTaskStreamTracker } from "./task-stream.js";

export { SdpppxProviderError, outputUrlsOf } from "./provider-support.js";

export const SDPPPX_DESCRIBE_TTL_MS = 5 * 60 * 1000;
const TASK_REQUEST_TIMEOUT_MS = 20_000;

export type SdpppxDescribe = {
  schema: SdpppxInputSchema;
  recommendUploadProvider: string | null;
  cancelable: boolean | null;
  /** describe 失败时的稳定码；成功为 null。 */
  error: string | null;
};

export type SdpppxProviderOptions = {
  config: () => SdpppxConfig;
  session: SessionManager;
  uploads: SdpppxReferenceUploader;
  /** 当前目录里的模板（providerModelId → 标题/类型）。 */
  templates: () => ReadonlyMap<string, SdpppxTemplate>;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
  jobRepository?: unknown;
  pollIntervalMs?: number;
  /** describe 成功给出推荐上传通道时通知调用方（上传发生在 describe 之后，但两者解耦）。 */
  onRecommendUploadProvider?: (provider: string) => void;
  log?: (event: Record<string, unknown>) => void;
};

function operationOf(value: unknown): {
  taskId: string;
  templateId: string;
  startedAt: number;
  modelType: "image" | "video";
} | null {
  if (!isRecord(value)) return null;
  const taskId = textOf(value.taskId);
  if (!taskId) return null;
  return {
    taskId,
    templateId: textOf(value.templateId) ?? "",
    startedAt: typeof value.startedAt === "number" && Number.isFinite(value.startedAt) ? value.startedAt : 0,
    modelType: value.modelType === "video" ? "video" : "image"
  };
}

export function createSdpppxProvider(options: SdpppxProviderOptions) {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const log = options.log ?? (() => undefined);
  const describeCache = new Map<string, { at: number; value: SdpppxDescribe }>();
  const describeInFlight = new Map<string, Promise<SdpppxDescribe>>();
  const streams = createTaskStreamTracker({ now, log });
  let lastRecommendUploadProvider: string | null = null;

  function timeoutMs(): number {
    return options.config().taskTimeoutMs;
  }

  async function requestJson(
    path: string,
    body: Record<string, unknown> | undefined,
    signal: AbortSignal | undefined,
    init: { method?: "POST" | "GET" } = {}
  ): Promise<RecordValue> {
    const config = options.config();
    if (config.degradedCode !== null) {
      throw new SdpppxProviderError("SDPPPX 部署参数不完整", config.degradedCode);
    }
    let token: string;
    try {
      token = await options.session.accessToken();
    } catch (error) {
      if (error instanceof SdpppxProviderError) throw error;
      throw new SdpppxProviderError(
        "登录已过期",
        textOf(isRecord(error) ? error.code : undefined) ?? "sdpppx-session-expired"
      );
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TASK_REQUEST_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const response = await fetchImpl(`${config.baseUrl}${path}`, {
        method: init.method ?? "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal
      });
      if (response.status === 401 || response.status === 403) {
        await options.session.clear("sdpppx-session-expired");
        throw new SdpppxProviderError("登录已过期", "sdpppx-session-expired", response.status);
      }
      if (!response.ok) {
        throw new SdpppxProviderError(
          "SDPPPX 服务暂不可用",
          "sdpppx-service-unavailable",
          response.status
        );
      }
      const text = await response.text();
      if (text.trim() === "") return {};
      try {
        const parsed: unknown = JSON.parse(text);
        return isRecord(parsed) ? parsed : {};
      } catch {
        throw new SdpppxProviderError("SDPPPX 返回了无法解析的响应", "sdpppx-service-unavailable", response.status);
      }
    } catch (error) {
      if (error instanceof SdpppxProviderError) throw error;
      log({ event: "sdpppx-task-request-failed", status: 0, timedOut });
      throw new SdpppxProviderError(
        timedOut ? "SDPPPX 请求超时" : "SDPPPX 服务暂不可用",
        "sdpppx-service-unavailable"
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async function cancelRemote(taskId: string, signal: AbortSignal | undefined): Promise<void> {
    try {
      await requestJson("/tasks/cancel", { taskId }, signal);
    } catch (error) {
      // 远端取消失败不把已取消的任务复活；本地 operation 仍按取消结束，只记诊断。
      log({
        event: "sdpppx-task-cancel-failed",
        code: error instanceof SdpppxProviderError ? error.code : "sdpppx-service-unavailable"
      });
    }
  }

  async function resultFor(
    modelType: "image" | "video",
    taskId: string,
    modelId: string,
    signal: AbortSignal | undefined
  ): Promise<Record<string, unknown>> {
    const payload = await requestJson("/tasks/result", { taskId }, signal);
    return resultFromPayload(modelType, taskId, modelId, payload, signal);
  }

  async function resultFromPayload(
    modelType: "image" | "video",
    _taskId: string,
    modelId: string,
    payload: RecordValue,
    signal: AbortSignal | undefined
  ): Promise<Record<string, unknown>> {
    const status = textOf(payload.status);
    if (status === "failed" || status === "cancelled") {
      throw new SdpppxProviderError(
        status === "cancelled" ? "任务已取消" : "任务失败",
        status === "cancelled" ? "sdpppx-task-cancelled" : "sdpppx-task-failed"
      );
    }
    if (status !== "succeeded") {
      throw new SdpppxProviderError("结果尚未就绪", "sdpppx-task-failed");
    }
    const urls = outputUrlsOf(payload);
    if (urls.length === 0) {
      throw new SdpppxProviderError("任务没有返回任何结果", "sdpppx-task-failed");
    }
    if (modelType === "video") {
      return {
        videos: urls.map((url) => ({
          type: "url" as const,
          url,
          mediaType: videoMediaTypeOf(url)
        })),
        warnings: [],
        providerMetadata: {
          [SDPPPX_PROVIDER_ID]: {
            videos: urls.map((url) => ({ url, mediaType: videoMediaTypeOf(url) }))
          }
        },
        response: { timestamp: new Date(now()), modelId }
      };
    }
    const downloaded = await downloadImages(fetchImpl, urls, signal);
    return {
      images: downloaded.images,
      warnings: [],
      providerMetadata: {
        [SDPPPX_PROVIDER_ID]: {
          images: urls.map((url, index) => ({
            url,
            mediaType: downloaded.mediaTypes[index] ?? "image/png"
          }))
        }
      },
      response: { timestamp: new Date(now()), modelId }
    };
  }

  function modelImplementation(modelType: "image" | "video"): PptaskImageModelImplementation | PptaskVideoModelImplementation {
    const implementation = {
      maxImagesPerCall: 1,
      maxVideosPerCall: 1,
      async doStart(rawOptions: unknown) {
        const input = isRecord(rawOptions) ? rawOptions : {};
        const model = textOf(input.__sdpppxModelId) ?? "";
        const templateId = textOf(input.__sdpppxTemplateId) ?? model;
        if (!templateId) {
          throw new SdpppxProviderError("模板不存在", "sdpppx-template-describe-failed");
        }
        const payload = isRecord(input.__sdpppxPayload) ? input.__sdpppxPayload : {};
        const config = options.config();
        let token: string;
        try {
          token = await options.session.accessToken();
        } catch {
          throw new SdpppxProviderError("登录已过期", "sdpppx-session-expired");
        }
        try {
          // 服务端只有 `POST /tasks/create_stream`（SSE）；拿到首个 `created` 后仍保持连接
          // 由后台读完事件，`doStatus` 优先用事件里的状态与结果，失败再回落轮询。
          const started = await streams.start({
            fetchImpl,
            url: `${config.baseUrl}/tasks/create_stream`,
            accessToken: token,
            tenantId: config.tenantId ?? "",
            templateId,
            payload
          });
          return { operation: { taskId: started.taskId, templateId, startedAt: now(), modelType } };
        } catch (error) {
          if (error instanceof CreateTaskError) {
            if (error.kind === "unauthorized") {
              await options.session.clear("sdpppx-session-expired");
              throw new SdpppxProviderError("登录已过期", "sdpppx-session-expired", error.status);
            }
            log({ event: "sdpppx-task-create-failed", status: error.status ?? 0, reason: error.reason });
            throw new SdpppxProviderError(
              error.message,
              error.status === 402 || error.status === 404
                ? "sdpppx-task-failed"
                : "sdpppx-service-unavailable",
              error.status
            );
          }
          throw error;
        }
      },
      async doStatus(raw: { operation: unknown; abortSignal?: AbortSignal }) {
        const operation = operationOf(raw.operation);
        if (!operation) {
          throw new SdpppxProviderError("任务状态已丢失", "sdpppx-task-failed");
        }
        const elapsed = now() - operation.startedAt;
        if (operation.startedAt > 0 && elapsed > timeoutMs()) {
          throw new SdpppxProviderError("任务超时", "sdpppx-task-timeout");
        }
        const kind = operation.modelType === "video" ? "video" : modelType;
        const streamed = streams.lookup(operation.taskId);
        if (streamed) {
          if (streamed.failureCode) {
            return { status: "error" as const, error: streamed.failureCode };
          }
          if (streamed.status === "succeeded" && streamed.outputs !== null) {
            return {
              status: "completed" as const,
              ...(await resultFromPayload(
                kind,
                operation.taskId,
                operation.templateId,
                { status: "succeeded", outputs: streamed.outputs },
                raw.abortSignal
              ))
            };
          }
          if (!streamed.finished && !streamed.streamError) {
            return {
              status: "pending" as const,
              phase:
                streamed.status === "running" || streamed.status === "processing"
                  ? ("running" as const)
                  : ("queued" as const)
            };
          }
        }
        const statusPayload = await requestJson(
          "/tasks/status",
          { taskId: operation.taskId },
          raw.abortSignal
        );
        const status = textOf(statusPayload.status) ?? "";
        if (status === "succeeded") {
          const result = await resultFor(kind, operation.taskId, operation.templateId, raw.abortSignal);
          return { status: "completed" as const, ...result };
        }
        if (status === "failed") {
          return { status: "error" as const, error: "sdpppx-task-failed" };
        }
        if (status === "cancelled") {
          return { status: "error" as const, error: "sdpppx-task-cancelled" };
        }
        return {
          status: "pending" as const,
          phase: status === "running" || status === "processing" ? ("running" as const) : ("queued" as const)
        };
      },
      async doCancel(raw: { operation: unknown; abortSignal?: AbortSignal }) {
        const operation = operationOf(raw.operation);
        if (!operation) return;
        await cancelRemote(operation.taskId, raw.abortSignal);
      }
    };
    return implementation as PptaskImageModelImplementation | PptaskVideoModelImplementation;
  }

  async function describe(templateId: string, modelType: "image" | "video"): Promise<SdpppxDescribe> {
    const cached = describeCache.get(templateId);
    if (cached && now() - cached.at < SDPPPX_DESCRIBE_TTL_MS) return cached.value;
    const inFlight = describeInFlight.get(templateId);
    if (inFlight) return inFlight;
    const run = (async (): Promise<SdpppxDescribe> => {
      const config = options.config();
      const fallback = (error: string | null): SdpppxDescribe => ({
        schema: buildSdpppxInputSchema({
          formSchema: undefined,
          promptField: config.promptField,
          minimal: true
        }),
        recommendUploadProvider: null,
        cancelable: null,
        error
      });
      if (config.degradedCode !== null) return fallback(config.degradedCode);
      try {
        const payload = await requestJson(
          `/tasks/describe?templateId=${encodeURIComponent(templateId)}`,
          undefined,
          undefined,
          { method: "GET" }
        );
        const schema = buildSdpppxInputSchema({
          formSchema: payload.formSchema,
          formValues: payload.formValues,
          promptField: config.promptField
        });
        const recommend = textOf(payload.recommendUploadProvider);
        if (recommend) {
          lastRecommendUploadProvider = recommend;
          options.onRecommendUploadProvider?.(recommend);
        }
        const cancelable = typeof payload.cancelable === "boolean" ? payload.cancelable : null;
        log({
          event: "sdpppx-template-described",
          mappedFields: schema.mappedFields,
          unknownFields: schema.unknownFields.length
        });
        return { schema, recommendUploadProvider: recommend ?? null, cancelable, error: null };
      } catch (error) {
        const code = error instanceof SdpppxProviderError ? error.code : "sdpppx-template-describe-failed";
        log({ event: "sdpppx-template-describe-failed", code, modelType });
        return fallback(code);
      }
    })();
    describeInFlight.set(templateId, run);
    try {
      const value = await run;
      describeCache.set(templateId, { at: now(), value });
      return value;
    } finally {
      describeInFlight.delete(templateId);
    }
  }

  function titleOf(templateId: string): string {
    return options.templates().get(templateId)?.title ?? templateId;
  }

  async function describeModel(
    templateId: string,
    modelType?: "image" | "video" | "language" | "audio"
  ): Promise<GenerationModelDescription> {
    const template = options.templates().get(templateId);
    const kind = modelType === "video" || template?.modelType === "video" ? "video" : "image";
    const described = await describe(templateId, kind);
    return {
      title: titleOf(templateId),
      inputSchema: described.schema.inputSchema,
      defaultInput: described.schema.defaultInput,
      promptRequirement: described.schema.promptRequirement,
      cancel: described.cancelable === false ? "local" : "remote"
    };
  }

  async function prepareInput(input: GenerationPrepareInput): Promise<Record<string, unknown>> {
    const described = await describe(input.providerModelId, input.modelType === "video" ? "video" : "image");
    const payload = buildSdpppxPayload(input, described.schema, options.config().promptField, options.uploads);
    return {
      // pptask 的 `doStart` 收到的就是这份对象。模板身份与 payload 用保留键携带；rawParams
      // 已并入 payload，不再单独出现。
      __sdpppxTemplateId: input.providerModelId,
      __sdpppxModelId: input.providerModelId,
      __sdpppxPayload: payload
    };
  }

  function clear(): void {
    describeCache.clear();
    describeInFlight.clear();
    streams.clear();
    lastRecommendUploadProvider = null;
  }

  const provider = createPptaskProvider({
    providerId: SDPPPX_PROVIDER_ID,
    imageModel: () => modelImplementation("image") as PptaskImageModelImplementation,
    videoModel: () => modelImplementation("video") as PptaskVideoModelImplementation,
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
    ...(options.jobRepository ? { jobRepository: options.jobRepository as never } : {})
  });

  return {
    provider,
    prepareInput,
    describeModel,
    clear,
    recommendUploadProvider: () => lastRecommendUploadProvider
  };
}

export type SdpppxProviderRuntime = ReturnType<typeof createSdpppxProvider>;

export function providerModelOf(provider: PptaskProvider, modelId: string, modelType: "image" | "video"): PptaskModel {
  return modelType === "video" ? provider.videoModel(modelId) : provider.imageModel(modelId);
}

/** 供插件与测试复用的稳定错误文案。 */
export function describeErrorOf(error: unknown): string {
  return stableMessage(error);
}
