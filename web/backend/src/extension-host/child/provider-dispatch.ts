/**
 * 子进程侧 Provider 调用分发（D6）。
 *
 * 宿主的 job 引擎留在宿主：宿主用远程桩包装模型实现，桩的每个方法发 `provider.model.call`
 * `{ providerId, modelType, modelId, method, options, context? }` 过来，这里调用真实
 * `provider[${modelType}Model](modelId)[method](options, context)`。
 *
 * - `abortSignal` 不过线：用 RPC 处理器的 signal（对端 `$/cancel` 时 abort）注入 `options.abortSignal`；
 * - 参数与结果可能很大（图片字节）：经 `decodeLarge` / `encodeLarge` 走 `rpc.large` 流；
 * - `doStream`：结果里的 `stream`（ReadableStream）改走 `provider.stream-parts` 流，每块一个 `v8.serialize(part)`，
 *   返回 `{ streamId, ...其余字段 }`；
 * - GenerationProvider 的函数成员（describeModel / prepareInput / resolveProviderModel / uploadReference）与
 *   `provider.upload` 同理。未实现的成员与方法抛 `extension-host-unsupported`。
 */
import v8 from "node:v8";
import { EXTENSION_HOST_METHODS, type GenerationProvider } from "@woohaa3/contracts";
import { RpcError, decodeLarge, encodeLarge, type RpcEndpoint } from "../rpc/index.js";

const MODEL_TYPES = new Set(["language", "image", "video", "audio"]);
const MODEL_METHODS = new Set(["doGenerate", "doStream", "doStart", "doStatus", "doCancel", "doDescribe"]);
const MEMBER_METHODS: Record<string, "describeModel" | "prepareInput" | "resolveProviderModel" | "uploadReference"> = {
  [EXTENSION_HOST_METHODS.providerDescribeModel]: "describeModel",
  [EXTENSION_HOST_METHODS.providerPrepareInput]: "prepareInput",
  [EXTENSION_HOST_METHODS.providerResolveModel]: "resolveProviderModel",
  [EXTENSION_HOST_METHODS.providerUploadReference]: "uploadReference"
};

export const PROVIDER_STREAM_PARTS_KIND = "provider.stream-parts";

type ModelCallParams = {
  providerId: string;
  modelType: string;
  modelId: string;
  method: string;
  options?: Record<string, unknown>;
  context?: unknown;
};

function unsupported(what: string): RpcError {
  return new RpcError("extension-host-unsupported", `子进程中的 Provider 未实现 ${what}`);
}

type Resolve = (providerId: string) => GenerationProvider | undefined;

function handleOf(resolve: Resolve, providerId: string): Record<string, unknown> {
  const provider = resolve(providerId);
  if (!provider) throw new RpcError("extension-unavailable", `Provider 未登记：${providerId}`);
  const handle = provider.provider as Record<string, unknown> | null | undefined;
  if (!handle || typeof handle !== "object") throw unsupported("执行句柄");
  return handle;
}

async function pipeParts(endpoint: RpcEndpoint, source: ReadableStream<unknown> | AsyncIterable<unknown>, signal: AbortSignal): Promise<string> {
  const out = endpoint.streams.open(PROVIDER_STREAM_PARTS_KIND);
  const iterate = async () => {
    try {
      const iterable = Symbol.asyncIterator in (source as object)
        ? (source as AsyncIterable<unknown>)
        : readableToIterable(source as ReadableStream<unknown>);
      for await (const part of iterable) {
        if (signal.aborted) throw new RpcError("rpc-cancelled", "已取消");
        const bytes = v8.serialize(part);
        await out.write(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      }
      out.end();
    } catch (error) {
      out.abort(error instanceof RpcError ? error.code : "stream-error");
    }
  };
  void iterate();
  return out.streamId;
}

async function* readableToIterable(stream: ReadableStream<unknown>): AsyncIterable<unknown> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export function installProviderDispatch(endpoint: RpcEndpoint, resolve: Resolve): void {
  endpoint.handle(EXTENSION_HOST_METHODS.providerModelCall, async (raw, { signal }) => {
    const params = (await decodeLarge(endpoint, raw)) as ModelCallParams;
    if (!MODEL_TYPES.has(params.modelType)) throw new RpcError("rpc-protocol-error", `未知模型类型：${params.modelType}`);
    if (!MODEL_METHODS.has(params.method)) throw unsupported(params.method);
    const handle = handleOf(resolve, params.providerId);
    const factory = handle[`${params.modelType}Model`];
    if (typeof factory !== "function") throw unsupported(`${params.modelType}Model`);
    const model = (factory as (id: string) => Record<string, unknown>).call(handle, params.modelId);
    const method = model?.[params.method];
    if (typeof method !== "function") throw unsupported(`${params.modelType}Model.${params.method}`);
    const options = params.method === "doDescribe" ? undefined : { ...(params.options ?? {}), abortSignal: signal };
    const result = await (method as (...args: unknown[]) => unknown).call(model, ...(options ? [options] : []), ...(params.context !== undefined ? [params.context] : []));
    if (params.method === "doStream" && result && typeof result === "object" && "stream" in result) {
      const { stream, ...rest } = result as { stream: ReadableStream<unknown> } & Record<string, unknown>;
      const streamId = await pipeParts(endpoint, stream, signal);
      return encodeLarge(endpoint, { ...rest, streamId });
    }
    return encodeLarge(endpoint, result === undefined ? null : result);
  });

  endpoint.handle(EXTENSION_HOST_METHODS.providerUpload, async (raw, { signal }) => {
    const params = (await decodeLarge(endpoint, raw)) as { providerId: string; options: Record<string, unknown> };
    const handle = handleOf(resolve, params.providerId);
    const upload = handle.upload;
    if (typeof upload !== "function") throw unsupported("upload");
    return encodeLarge(endpoint, await (upload as (options: unknown) => unknown).call(handle, { ...params.options, abortSignal: signal }));
  });

  for (const [method, member] of Object.entries(MEMBER_METHODS)) {
    endpoint.handle(method, async (raw) => {
      const params = (await decodeLarge(endpoint, raw)) as { providerId: string; input: unknown };
      const provider = resolve(params.providerId);
      if (!provider) throw new RpcError("extension-unavailable", `Provider 未登记：${params.providerId}`);
      const fn = provider[member];
      if (typeof fn !== "function") throw unsupported(member);
      const result = await (fn as (input: unknown) => unknown).call(provider, params.input);
      return encodeLarge(endpoint, result === undefined ? null : result);
    });
  }

  endpoint.handle(EXTENSION_HOST_METHODS.providerDescribe, async (raw) => {
    const params = raw as { providerId: string; providerModelId: string };
    const provider = resolve(params.providerId);
    if (!provider) throw new RpcError("extension-unavailable", `Provider 未登记：${params.providerId}`);
    return provider.describe?.(params.providerModelId) ?? provider.models.find((model) => (model as { providerModelId?: string }).providerModelId === params.providerModelId) ?? null;
  });
}
