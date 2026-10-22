/**
 * 有序 Provider 资源注册表
 * （change: add-pluggable-model-interactions，任务 1.3 / 2.1 / design D1 / D7）。
 *
 * 职责：
 * - 按稳定顺序注册可用 Provider（LiteLLM → Ark video），每个资源带稳定 `providerId`；
 * - 为每个 Provider 资源发行 catalog 内唯一的 opaque `modelKey`（`<providerId>:<providerModelId>`）；
 * - **允许** 不同 Provider 暴露相同 `providerModelId` —— 身份不再假设全局唯一；
 * - 执行时按 catalog 解析出的 `providerId` **固定** Provider，不重新猜测。
 *
 * 调用方（Canvas/Frontend）只按 `modelKey` 查找，绝不解析它推导 Provider。
 */
import type { CanvasTaskModelType } from "@woohaa3/contracts";
import type { ProviderCatalog, TaskCatalogProvider } from "../catalog/types.js";
import type { PptaskProvider } from "@sdppp/pptask";

export type RegisteredResource = {
  /** catalog 内唯一、opaque 的调用身份。 */
  modelKey: string;
  providerId: string;
  providerModelId: string;
  modelType: CanvasTaskModelType;
};

export type ProviderRegistryEntry = {
  providerId: string;
  provider: PptaskProvider;
  catalog: ProviderCatalog;
};

export type TaskProviderRegistry = {
  /** 按稳定顺序的全部资源（已按 modelKey 去重，先注册优先）。 */
  resources: readonly RegisteredResource[];
  /** catalog 视图：把资源映射回其 Provider 的 describe。 */
  catalog: TaskCatalogProvider;
  /** 执行时按 providerId 解析 Provider。 */
  resolveProvider(providerId: string | undefined): PptaskProvider | undefined;
  /** 给定 opaque modelKey，返回 catalog 固定的 (providerId, providerModelId, modelType)。 */
  resolveResource(modelKey: string): RegisteredResource | undefined;
};

/** 稳定 opaque modelKey：`<providerId>:<providerModelId>`，只发行不解析。 */
export function toModelKey(providerId: string, providerModelId: string): string {
  return `${providerId}:${providerModelId}`;
}

/**
 * 建立注册表。`entries` 必须按优先级顺序给出（LiteLLM 在前）。
 *
 * 同 `modelKey` 只保留**第一个**注册资源；不同 Provider 的同名 `providerModelId`
 * 因为 providerId 前缀不同而互不冲突。
 */
export function createTaskProviderRegistry(entries: readonly ProviderRegistryEntry[]): TaskProviderRegistry {
  const providerById = new Map<string, PptaskProvider>();
  const resourceByKey = new Map<string, RegisteredResource>();
  const resources: RegisteredResource[] = [];
  const catalogByProvider = new Map<string, ProviderRegistryEntry["catalog"]>();

  for (const entry of entries) {
    if (!providerById.has(entry.providerId)) {
      providerById.set(entry.providerId, entry.provider);
      catalogByProvider.set(entry.providerId, entry.catalog);
    }
    for (const model of entry.catalog.listModels()) {
      const modelKey = toModelKey(entry.providerId, model.providerModelId);
      if (resourceByKey.has(modelKey)) continue; // 先注册优先
      const resource: RegisteredResource = {
        modelKey,
        providerId: entry.providerId,
        providerModelId: model.providerModelId,
        modelType: model.modelType
      };
      resourceByKey.set(modelKey, resource);
      resources.push(resource);
    }
  }

  const catalog: TaskCatalogProvider = {
    listModels() {
      return resources.map((resource) => ({
        modelKey: resource.modelKey,
        providerId: resource.providerId,
        providerModelId: resource.providerModelId,
        modelType: resource.modelType
      }));
    },
    async describe(modelKey) {
      const resource = resourceByKey.get(modelKey);
      if (!resource) throw new Error(`注册表不含模型：${modelKey}`);
      const providerCatalog = catalogByProvider.get(resource.providerId);
      if (!providerCatalog) throw new Error(`模型 ${modelKey} 的 Provider ${resource.providerId} 未注册`);
      return providerCatalog.describe(resource.providerModelId);
    }
  };

  return {
    resources,
    catalog,
    resolveProvider(providerId) {
      if (providerId === undefined) return resources.length > 0 ? providerById.get(resources[0]!.providerId) : undefined;
      return providerById.get(providerId);
    },
    resolveResource(modelKey) {
      return resourceByKey.get(modelKey);
    }
  };
}
