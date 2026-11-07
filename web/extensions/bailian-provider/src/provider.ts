/**
 * 百炼生图执行。
 *
 * 同步接口：`POST {origin}/api/v1/services/aigc/multimodal-generation/generation`。
 * 成功时从 `output.choices[].message.content[].image` 取地址，交给共享实现下载成字节
 * （走插件的受控 fetch）。图片地址 24 小时过期，所以必须当场下载，不能只存 URL。
 */
import type { PptaskDescription, PptaskModelType, PptaskProvider } from "@sdppp/pptask";
import {
  createHttpProvider,
  jsonRequest,
  mergeHeaders,
  normalizeProviderConfig,
  ProviderHttpError,
  requestJson,
  type CommonProviderOptions,
  type HttpExecutionContext,
  type HttpProviderProtocol,
  type NormalizedProviderConfig
} from "@sdppp/pptask/providers/shared";
import { findBailianModel, type BailianModelSpec } from "./catalog.js";
import { bailianErrorMessage, buildBailianImageBody, describeBailianModel, readBailianImages } from "./schema.js";
import { BAILIAN_IMAGE_PATH, BAILIAN_PROVIDER_ID, bailianOrigin } from "./shared.js";

export type BailianProviderOptions = CommonProviderOptions & { apiKey: string };

export function createBailianProvider(options: BailianProviderOptions): PptaskProvider {
  const config = normalizeProviderConfig(BAILIAN_PROVIDER_ID, options, "");
  if (!config.baseURL) throw new Error("百炼需要 baseURL");
  const origin = bailianOrigin(config.baseURL);

  const protocol: HttpProviderProtocol = {
    providerId: BAILIAN_PROVIDER_ID,
    fetch: config.fetch,
    modelTypes: ["image"],
    mode: () => "sync",
    validateModel(modelId, modelType) {
      if (modelType !== "image") throw new Error(`百炼只接入生图，不支持 ${modelType} 模型：${modelId}`);
      requireModel(modelId);
    },
    async execute(context) {
      return executeImage(context, config, origin);
    },
    // 只有同步模型，没有可查询的远端任务：走到这里说明调用方误把它当异步模型用了。
    async status() {
      throw new Error("百炼生图是同步接口，没有可查询的任务");
    },
    describe: async (modelId, modelType) => describeModel(modelId, modelType)
  };

  return createHttpProvider(protocol, {
    apiKey: config.apiKey,
    baseURL: origin,
    fetch: config.fetch
  });
}

export function describeModel(modelId: string, modelType: PptaskModelType = "image"): PptaskDescription {
  const model = requireModel(modelId);
  const description = describeBailianModel(model);
  return {
    providerId: BAILIAN_PROVIDER_ID,
    modelId: model.id,
    modelType,
    ...(description.title ? { title: description.title } : {}),
    ...(description.inputSchema ? { inputSchema: description.inputSchema } : {}),
    ...(description.defaultInput ? { defaultInput: description.defaultInput } : {}),
    capabilities: {
      mediaKind: "image",
      operations: model.maxReferenceImages > 0 ? ["text-to-image", "image-to-image"] : ["text-to-image"],
      cancel: false
    }
  };
}

/**
 * 任务服务只落第一张图（`normalizeProviderResult` 取 `images[0]`），所以即使模型支持 `n` 也
 * 只请求一张：多出来的图既进不了画布，还会照常计费。
 */
async function executeImage(
  context: HttpExecutionContext,
  config: NormalizedProviderConfig,
  origin: string
): Promise<unknown> {
  const model = requireModel(context.modelId);
  const body = buildBailianImageBody(model, context.input);
  const payload = await postJson(config, origin, body, context);
  const error = bailianErrorMessage(payload);
  if (error !== "") throw new Error(error);
  const urls = readBailianImages(payload);
  if (urls.length === 0) throw new Error("百炼没有返回图片");
  return { data: urls.map((url) => ({ url })) };
}

async function postJson(
  config: NormalizedProviderConfig,
  origin: string,
  body: unknown,
  context: HttpExecutionContext
): Promise<unknown> {
  try {
    return await requestJson(
      config.fetch,
      BAILIAN_PROVIDER_ID,
      jsonRequest(
        `${origin}${BAILIAN_IMAGE_PATH}`,
        body,
        mergeHeaders({ authorization: `Bearer ${config.apiKey ?? ""}` }, context.headers)
      ),
      context.signal
    );
  } catch (error) {
    // DashScope 的参数错误与审核失败都是 HTTP 400，业务原因在 `{code, message}` 里；
    // 共享实现把整个 body 拼进了 message，这里换成可读原因，同时保留状态码便于排障。
    if (error instanceof ProviderHttpError && error.bodyText) {
      const reason = bailianErrorMessage(parseJson(error.bodyText));
      if (reason !== "") throw new Error(`${reason}（HTTP ${error.status}）`);
    }
    throw error;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function requireModel(modelId: string): BailianModelSpec {
  const model = findBailianModel(modelId);
  if (!model) throw new Error(`百炼模型未登记：${modelId}`);
  return model;
}
