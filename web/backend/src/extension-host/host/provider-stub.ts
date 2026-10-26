/**
 * Provider 远程桩（change: 2026-10-21-isolate-extension-host-process，D6，任务 4.3）。
 *
 * 宿主拿到的是一个**宿主构造**的 `GenerationProvider`：
 * - 可序列化字段（providerId / available / models / selectionAuthority / catalogRevision）来自子进程登记；
 * - `provider` 句柄用宿主自己的 `createPptaskProvider` 构造（job 引擎、执行事实上报、job 持久化都在宿主），
 *   但它的每个模型实现（doGenerate / doStream / doStart / doStatus / doCancel / doDescribe）都是 RPC 桩，
 *   调用 `provider.model.call` 交给子进程执行真实模型。Task worker 无需改动。
 * - 函数成员（describeModel / prepareInput / resolveProviderModel / uploadReference）只为子进程声明了的成员装桩；
 *   `describe` 在宿主本地从登记的模型列表应答（同步，不跨进程）。
 *
 * 失败语义：实例不可用时桩立即以 `extension-unavailable` 失败；调用途中实例死亡由 RPC 层以
 * `extension-crashed` 失败。RPC 层不重试（生成提交交给 Task 的既有重试与 lease）。
 */
import {
  EXTENSION_HOST_LIMITS,
  EXTENSION_HOST_METHODS,
  type ExtensionHostModelMethod,
  type ExtensionHostProviderRegistration,
  type GenerationModelDefinition,
  type GenerationProvider
} from "@woohaa3/contracts";
import { createPptaskProvider, type PptaskJobRepository, type PptaskExecutionReporter } from "@sdppp/pptask";
import { decodeLarge, encodeLarge, RpcError, type RpcEndpoint } from "../rpc/index.js";

export type StubModelType = "language" | "image" | "video" | "audio";
type StubModelMethod = ExtensionHostModelMethod;

/** 当前服务该扩展的实例（蓝绿切换时原子替换；不可用时为 null）。 */
export type StubTarget = () => RpcEndpoint | null;

export type ProviderStubOptions = {
  extensionId: string;
  registration: ExtensionHostProviderRegistration;
  target: StubTarget;
  /** 宿主 job 仓库（与 Task worker 共用时传入）；缺省用 pptask 内存仓库。 */
  jobRepository?: PptaskJobRepository;
  executionReporter?: PptaskExecutionReporter;
  /** 生成执行类调用的超时（缺省取模型 taskTimeoutMs，上限 15 min）。 */
  executionTimeoutMs?: (modelType: StubModelType, modelId: string) => number | undefined;
};

const DEFAULT_METHODS: readonly StubModelMethod[] = ["doGenerate"];
const EXECUTION_METHODS = new Set<StubModelMethod>(["doGenerate", "doStream", "doStart"]);

function unavailable(extensionId: string): RpcError {
  return new RpcError("extension-unavailable", `扩展 ${extensionId} 当前不可用`, { extensionId });
}

/** 发一次 RPC：参数按需走大载荷流，结果按需解码；AbortSignal 映射为 `$/cancel`。 */
async function call<T>(
  options: ProviderStubOptions,
  method: string,
  params: Record<string, unknown>,
  request: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<T> {
  const endpoint = options.target();
  if (!endpoint || endpoint.closed) throw unavailable(options.extensionId);
  const payload = encodeLarge(endpoint, params);
  const result = await endpoint.request(method, payload, {
    ...(request.signal ? { signal: request.signal } : {}),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {})
  });
  return decodeLarge<T>(endpoint, result);
}

/** 去掉不能过 IPC 的调用选项（AbortSignal 由 `$/cancel` 表达）。 */
function wireOptions(value: unknown): { options: unknown; signal?: AbortSignal } {
  if (!value || typeof value !== "object") return { options: value };
  const { abortSignal, signal, ...rest } = value as Record<string, unknown> & { abortSignal?: AbortSignal; signal?: AbortSignal };
  const effective = abortSignal ?? signal;
  return { options: rest, ...(effective ? { signal: effective } : {}) };
}

function modelKey(modelType: StubModelType, modelId: string): string {
  return `${modelType}:${modelId}`;
}

/** doStream 的结果：子进程回 `{ streamId, ...rest }`，流里每块是一个 v8 序列化的 part。 */
async function decodeStreamResult(endpoint: RpcEndpoint, result: Record<string, unknown>): Promise<unknown> {
  const { streamId, ...rest } = result as { streamId?: string } & Record<string, unknown>;
  if (typeof streamId !== "string") return result;
  const incoming = endpoint.streams.take(streamId);
  const { deserialize } = await import("node:v8");
  const stream = new ReadableStream<unknown>({
    async start(controller) {
      try {
        for await (const chunk of incoming) controller.enqueue(deserialize(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      incoming.cancel(String(reason ?? "cancelled"));
    }
  });
  return { ...rest, stream };
}

function modelImplementation(options: ProviderStubOptions, modelType: StubModelType, modelId: string): Record<string, unknown> {
  const info = (options.registration.modelInfo as Readonly<Record<string, { methods: readonly StubModelMethod[]; maxImagesPerCall?: number }>> | undefined)?.[modelKey(modelType, modelId)];
  const methods = new Set(info?.methods ?? DEFAULT_METHODS);
  const implementation: Record<string, unknown> = {};
  if (modelType === "language") implementation.supportedUrls = {};
  if (modelType === "image") implementation.maxImagesPerCall = info?.maxImagesPerCall ?? 1;
  for (const method of methods) {
    implementation[method] = async (rawOptions: unknown, context?: unknown) => {
      const { options: wire, signal } = wireOptions(rawOptions);
      const configured = options.executionTimeoutMs?.(modelType, modelId);
      const timeoutMs = EXECUTION_METHODS.has(method)
        ? Math.min(configured ?? EXTENSION_HOST_LIMITS.maxExecutionTimeoutMs, EXTENSION_HOST_LIMITS.maxExecutionTimeoutMs)
        : undefined;
      const result = await call<unknown>(
        options,
        EXTENSION_HOST_METHODS.providerModelCall,
        {
          providerId: options.registration.providerId,
          modelType,
          modelId,
          method,
          options: wire,
          ...(context !== undefined ? { context } : {})
        },
        { ...(signal ? { signal } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}) }
      );
      if (method === "doStream" && result && typeof result === "object") {
        const endpoint = options.target();
        if (!endpoint) throw unavailable(options.extensionId);
        return decodeStreamResult(endpoint, result as Record<string, unknown>);
      }
      return result;
    };
  }
  return implementation;
}

/** 用登记信息构造宿主侧 GenerationProvider。 */
export function createProviderStub(options: ProviderStubOptions): GenerationProvider {
  const { registration, extensionId } = options;
  const providerId = registration.providerId;
  const models = registration.models as GenerationModelDefinition[];
  const pptask = createPptaskProvider({
    providerId,
    languageModel: (id: string) => modelImplementation(options, "language", id) as never,
    imageModel: (id: string) => modelImplementation(options, "image", id) as never,
    videoModel: (id: string) => modelImplementation(options, "video", id) as never,
    audioModel: (id: string) => modelImplementation(options, "audio", id) as never,
    files: {
      specificationVersion: "v4",
      provider: providerId,
      uploadFile: async (uploadOptions: unknown) => {
        const { options: wire, signal } = wireOptions(uploadOptions);
        return call(options, EXTENSION_HOST_METHODS.providerUpload, { providerId, options: wire }, signal ? { signal } : {});
      }
    } as never,
    ...(options.jobRepository ? { jobRepository: options.jobRepository } : {}),
    ...(options.executionReporter ? { executionReporter: options.executionReporter } : {})
  });

  const members = new Set(registration.members);
  const stub: GenerationProvider = {
    extensionId,
    providerId,
    available: registration.available,
    ...(registration.selectionAuthority ? { selectionAuthority: registration.selectionAuthority } : {}),
    ...(registration.catalogRevision !== undefined ? { catalogRevision: registration.catalogRevision } : {}),
    provider: pptask,
    models,
    // 本地应答：登记的模型列表就是子进程的权威目录（变化时子进程会重发登记）。
    describe: (providerModelId) => models.find((model) => model.providerModelId === providerModelId)
  };
  if (members.has("describeModel")) {
    stub.describeModel = (input) => call(options, EXTENSION_HOST_METHODS.providerDescribeModel, { providerId, input });
  }
  if (members.has("prepareInput")) {
    stub.prepareInput = (input) => call(options, EXTENSION_HOST_METHODS.providerPrepareInput, { providerId, input });
  }
  if (members.has("resolveProviderModel")) {
    stub.resolveProviderModel = (input) => call(options, EXTENSION_HOST_METHODS.providerResolveModel, { providerId, input });
  }
  if (members.has("uploadReference")) {
    stub.uploadReference = (input) => call(options, EXTENSION_HOST_METHODS.providerUploadReference, { providerId, input });
  }
  return stub;
}
