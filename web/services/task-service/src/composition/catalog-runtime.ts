/**
 * Task Service composition：provider registry 与 catalog 懒构建
 * （自 `composition.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R10）。
 *
 * registry 懒构建（后端 Cordis 插件在 composition 后期注册）；catalog 随注册表与运营策略
 * 变化推进 catalogRevision。
 */
import type { CanvasTaskCatalog } from "@woohaa3/contracts";
import { createTaskProviderRegistry, type ProviderRegistryEntry, type TaskProviderRegistry } from "../providers/registry.js";
import { buildCanvasTaskCatalog } from "../catalog/build-catalog.js";
import type { ModelsConfig, ResolvedModel } from "../config/models-config.js";
import { unavailableCatalog } from "./http-handlers.js";

export type CatalogRuntimeOptions = {
  generationProviders?: () => readonly import("@woohaa3/contracts").GenerationProvider[];
  modelsConfig: ModelsConfig;
  resolveModelSelection?: (registry: ReadonlyArray<{ modelKey: string; providerId: string; providerModelId: string; modelType: import("@woohaa3/contracts").CanvasTaskModelType }>) =>
    | { ok: true; models: ResolvedModel[]; defaults: Partial<Record<import("@woohaa3/contracts").CanvasTaskModelType, string>> }
    | { ok: false; reason: string };
  /**
   * 运营策略的版本戳。策略只改启用集合、不改注册表时，目录也要重算。
   * 缺省时目录只跟注册表和 modelsConfig 走。
   */
  selectionStamp?: () => string;
};

export type CatalogRuntime = {
  registry: () => TaskProviderRegistry;
  resolveCatalog: () => Promise<CanvasTaskCatalog>;
  /**
   * 当前任务目录修订（单调）。只算签名、必要时推进 revision 并使缓存失效，**不**构建完整
   * catalog（不调 Provider describe），供已被轮询的宿主快照轻量读取。
   */
  catalogRevision: () => number;
};

/** 构建 provider registry + catalog 懒解析（二者共享缓存签名）。 */
export function createCatalogRuntime(options: CatalogRuntimeOptions): CatalogRuntime {
  const buildRegistryEntries = (): ProviderRegistryEntry[] => {
    const externalProviders = options.generationProviders?.() ?? [];
    return externalProviders
      .filter((entry) => entry.available && entry.provider != null)
      .map((entry) => ({
        providerId: entry.providerId,
        provider: entry.provider as never,
        catalog: {
          listModels: () =>
            entry.models
              .filter((model) => model.executable !== false)
              .map((model) => ({ providerModelId: model.providerModelId, modelType: model.modelType })),
          describe: async (providerModelId) => {
            const model = entry.models.find((candidate) => candidate.providerModelId === providerModelId);
            if (!model) throw new Error(`生成 Provider ${entry.providerId} 不含模型：${providerModelId}`);
            let dynamic: import("@woohaa3/contracts").GenerationModelDescription | undefined;
            try {
              dynamic = await entry.describeModel?.({ providerModelId, modelType: model.modelType });
            } catch {
              dynamic = undefined;
            }
            return {
              providerId: entry.providerId,
              modelId: model.providerModelId,
              modelType: model.modelType,
              ...(dynamic?.title ?? model.title ? { title: dynamic?.title ?? model.title } : {}),
              ...(dynamic?.inputSchema ?? model.inputSchema ? { inputSchema: dynamic?.inputSchema ?? model.inputSchema } : {}),
              ...(dynamic?.defaultInput ?? model.defaultInput ? { defaultInput: dynamic?.defaultInput ?? model.defaultInput } : {}),
              ...(dynamic?.capabilities ?? model.capabilities ? { capabilities: dynamic?.capabilities ?? model.capabilities } : {}),
              ...(dynamic?.capabilityFacts ?? model.capabilityFacts
                ? { capabilityFacts: dynamic?.capabilityFacts ?? model.capabilityFacts }
                : {}),
              ...(dynamic?.promptRequirement ?? model.promptRequirement ? { promptRequirement: dynamic?.promptRequirement ?? model.promptRequirement } : {}),
              ...(dynamic?.cancel ?? model.cancel ? { cancel: dynamic?.cancel ?? model.cancel } : {})
            };
          }
        }
      }));
  };

  let registryCache: TaskProviderRegistry | null = null;
  let registrySignature = "";
  const generationSignature = (): string => {
    const providers = options.generationProviders?.() ?? [];
    return providers.map((entry) => {
      // 能力事实也参与签名：discovery 刷新只改画是否可读图时，目录必须失效重算。
      const models = entry.models
        .map((model) => `${model.modelType}:${model.providerModelId}:${model.executable === false ? "0" : "1"}:${JSON.stringify(model.capabilityFacts ?? null)}`)
        .join("+");
      // Provider 的 catalogRevision 参与签名：远端 Provider 只改 schema/能力、不改模型 id 集合时，
      // 目录也要失效重算（否则已打开的画布看不到新描述）。
      return `${entry.providerId}:${entry.available}:${entry.catalogRevision ?? ""}:${models}`;
    }).sort().join(",");
  };
  const registry = (): TaskProviderRegistry => {
    const signature = generationSignature();
    if (!registryCache || signature !== registrySignature) {
      registrySignature = signature;
      registryCache = createTaskProviderRegistry(buildRegistryEntries());
    }
    return registryCache;
  };

  let catalogPromise: Promise<CanvasTaskCatalog> | null = null;
  let catalogRevision = 0;
  const catalogSignature = (): string =>
    registry().resources
      .map((resource) => resource.modelKey)
      .sort()
      .join(",") + `|${generationSignature()}|${JSON.stringify(options.modelsConfig)}|${options.selectionStamp?.() ?? ""}`;
  let lastSignature = "";
  /**
   * 签名变化时推进 revision 并使已构建的 catalog 失效。resolveCatalog 与 catalogRevision()
   * 共用这一处，保证两条读取路径的进度一致（不会因为轻量读而漏掉/重复推进）。
   */
  const bumpRevisionForSignatureChange = (): void => {
    const signature = catalogSignature();
    if (signature === lastSignature) return;
    lastSignature = signature;
    catalogRevision += 1;
    catalogPromise = null;
  };
  const resolveCatalog = (): Promise<CanvasTaskCatalog> => {
    bumpRevisionForSignatureChange();
    catalogPromise ??= (async () => {
      if (registry().resources.length === 0) {
        return { ...unavailableCatalog("暂无可用模型，请在「Provider 凭据」中配置 API Key，并确认 Provider 已启用"), catalogRevision };
      }
      const catalog = await buildCanvasTaskCatalog(registry().catalog, options.modelsConfig, options.resolveModelSelection);
      return { ...catalog, catalogRevision };
    })();
    return catalogPromise;
  };
  /** 轻量读：只算签名（registry 已按签名缓存），不构建 catalog、不调 describe。 */
  const catalogRevisionNow = (): number => {
    bumpRevisionForSignatureChange();
    return catalogRevision;
  };

  return { registry, resolveCatalog, catalogRevision: catalogRevisionNow };
}
