/**
 * 子进程侧的 `ctx.generation`（D4/D6）。
 *
 * `register(provider)` 把**可序列化部分**上报宿主（`ctx.generation.register`），函数成员与 `provider` 句柄留在
 * 本进程：宿主桩通过 `provider.*` 请求回调这里（见 `provider-dispatch.ts`）。扩展运行中改写 `models`（例如模型
 * 刷新后 splice）时，`sync()` 比较可序列化快照，变化就重发 register（同 providerId 视为替换）。
 */
import {
  EXTENSION_HOST_METHODS,
  EXTENSION_HOST_MODEL_METHODS,
  type ExtensionHostModelInfo,
  type ExtensionHostProviderRegistration,
  type GenerationProvider
} from "@woohaa3/contracts";
import type { RpcEndpoint } from "../rpc/index.js";

const MEMBERS = ["describe", "describeModel", "prepareInput", "uploadReference", "resolveProviderModel"] as const;

export type ChildGeneration = {
  service: {
    register(provider: GenerationProvider): () => void;
    unregister(providerId: string): void;
    registerConversion(): () => void;
    list(): readonly GenerationProvider[];
    resolve(providerId: string): GenerationProvider | undefined;
    conversions(): readonly never[];
  };
  resolve(providerId: string): GenerationProvider | undefined;
  /** 重新比较全部已登记 Provider 的可序列化部分，变化即重发。 */
  sync(): void;
};

/**
 * 探测每个模型实现对象上实际存在的方法（pptask job 引擎据此选择 operation 还是 doGenerate）。
 * 模型工厂抛错的模型不进表（宿主按 doGenerate 处理，真正调用时会得到同样的错误）。
 */
export function probeModelInfo(provider: GenerationProvider): Record<string, ExtensionHostModelInfo> {
  const handle = provider.provider as Record<string, unknown> | null | undefined;
  const info: Record<string, ExtensionHostModelInfo> = {};
  if (!handle || typeof handle !== "object") return info;
  for (const model of provider.models ?? []) {
    const { modelType, providerModelId } = model as { modelType?: string; providerModelId?: string };
    if (!modelType || !providerModelId) continue;
    const modelFactory: unknown = handle[`${modelType}Model`];
    if (typeof modelFactory !== "function") continue;
    try {
      const instance = (modelFactory as (id: string) => Record<string, unknown>).call(handle, providerModelId);
      if (!instance || typeof instance !== "object") continue;
      const methods = EXTENSION_HOST_MODEL_METHODS.filter((method) => typeof instance[method] === "function");
      const max = instance.maxImagesPerCall;
      info[`${modelType}:${providerModelId}`] = { methods, ...(typeof max === "number" ? { maxImagesPerCall: max } : {}) };
    } catch {
      // 模型工厂失败：不进表。
    }
  }
  return info;
}

export function serializeRegistration(provider: GenerationProvider): ExtensionHostProviderRegistration {
  return {
    modelInfo: probeModelInfo(provider),
    providerId: provider.providerId,
    available: provider.available === true,
    // 结构化克隆可接受的纯数据；模型定义里不应有函数（有的话在这里就暴露为克隆错误）。
    models: structuredClone(provider.models ?? []),
    ...(provider.selectionAuthority ? { selectionAuthority: provider.selectionAuthority } : {}),
    ...(typeof provider.catalogRevision === "number" ? { catalogRevision: provider.catalogRevision } : {}),
    members: MEMBERS.filter((member) => typeof provider[member] === "function")
  };
}

export function createChildGeneration(endpoint: RpcEndpoint): ChildGeneration {
  const providers = new Map<string, { provider: GenerationProvider; snapshot: string }>();

  const publish = (provider: GenerationProvider) => {
    const registration = serializeRegistration(provider);
    const snapshot = JSON.stringify(registration);
    const previous = providers.get(provider.providerId);
    providers.set(provider.providerId, { provider, snapshot });
    if (previous?.snapshot === snapshot && previous.provider === provider) return;
    endpoint.notify(EXTENSION_HOST_METHODS.ctxGenerationRegister, registration);
  };

  const unregister = (providerId: string) => {
    if (!providers.delete(providerId)) return;
    try {
      endpoint.notify(EXTENSION_HOST_METHODS.ctxGenerationUnregister, { providerId });
    } catch {
      // 端点关闭：宿主侧随崩溃处理撤注册。
    }
  };

  return {
    service: {
      register(provider) {
        publish(provider);
        return () => {
          if (providers.get(provider.providerId)?.provider === provider) unregister(provider.providerId);
        };
      },
      unregister,
      registerConversion() {
        throw Object.assign(new Error("受管扩展不能注册「转为片场」转换提供方"), { code: "permission-denied" });
      },
      list: () => [...providers.values()].map((entry) => entry.provider),
      resolve: (providerId) => providers.get(providerId)?.provider,
      conversions: () => []
    },
    resolve: (providerId) => providers.get(providerId)?.provider,
    sync() {
      for (const { provider } of [...providers.values()]) {
        try {
          publish(provider);
        } catch {
          // 单个 Provider 快照失败不影响其他。
        }
      }
    }
  };
}
