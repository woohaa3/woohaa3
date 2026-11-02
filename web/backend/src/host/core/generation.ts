/**
 * 核心层 · generation：`ctx.generation` 扩展点。
 *
 * Provider 插件在这里注册，Task 从这里读取。同时拥有站点级模型策略（启停、默认值）与
 * `/api/generation-models` 管理面。Provider 的密钥是它自己配置段里的 `secret` 字段，经设置服务写入。
 */
import path from "node:path";
import { readRuntimeModelViews, mergeRuntimeModelViews } from "./runtime-model-catalog.js";
import type {
  FilmSetConversionProvider,
  GenerationModelPolicyView,
  GenerationModelsSnapshot,
  GenerationProvider,
  HostGenerationService
} from "@woohaa3/contracts";
import { createSqliteGenerationModelStore } from "@woohaa3/application-service";
import { createGenerationModelsApiHandler } from "../../api/generation-models-api.js";
import type { GenerationModelPolicyStore, GenerationService, HostContext, HostPlugin } from "../context.js";
import { ROUTE_ORDER } from "../order.js";

export function createGenerationRegistry(options: { logger?: (event: Record<string, unknown>) => void } = {}): HostGenerationService {
  const log = options.logger ?? (() => undefined);
  const registry = new Map<string, GenerationProvider>();
  const conversions = new Set<FilmSetConversionProvider>();
  const unregister = (providerId: string) => {
    if (registry.delete(providerId)) log({ event: "generation-provider-unregistered", providerId });
  };
  return {
    register(registration) {
      if (registry.has(registration.providerId)) {
        throw new Error(`生成 Provider 已注册：${registration.providerId}`);
      }
      registry.set(registration.providerId, registration);
      log({ event: "generation-provider-registered", providerId: registration.providerId, extensionId: registration.extensionId });
      return () => {
        if (registry.get(registration.providerId) === registration) unregister(registration.providerId);
      };
    },
    unregister,
    registerConversion(provider) {
      conversions.add(provider);
      return () => {
        conversions.delete(provider);
      };
    },
    list: () => [...registry.values()],
    resolve: (providerId) => registry.get(providerId),
    conversions: () => [...conversions]
  };
}

/** 生成模型策略库放在 Task 存储目录旁。 */
export function generationPolicyPath(env: Record<string, string | undefined>): string {
  const configured = env.WOOHAA3_TASK_STORE_PATH ?? env.WOOHAA3_APPLICATION_STORE_PATH ?? "";
  return path.join(path.dirname(configured === "" ? "." : configured), "generation-models.sqlite");
}

export const generationPlugin: HostPlugin<{ env: Record<string, string | undefined> }> = {
  name: "generation",
  inject: ["log", "gateway", "access"],
  apply(ctx, { env }) {
    const registry = createGenerationRegistry({ logger: ctx.log.scope("generation") });
    const policy = createSqliteGenerationModelStore({ path: generationPolicyPath(env) });
    ctx.effect(() => () => policy.close());
    const service: GenerationService = { ...registry, policy };
    ctx.provide("generation", service);
    ctx.effect(() => ctx.gateway.route(ROUTE_ORDER.generationModels, createModelsApi(ctx, service, policy, readRuntimeModelViews(env.WOOHAA3_RUNTIME_MODELS_PATH))));
  }
};

function modelKeys(generation: HostGenerationService): Set<string> {
  return new Set(generation.list().flatMap((provider) => provider.models.map((model) => `${provider.providerId}:${model.providerModelId}`)));
}

/**
 * 设置页要看到注册表里的每一个模型，而不只是策略里已经写过的那些。
 * 策略未初始化时注册表模型视为启用（与 catalog 一致）；已初始化但策略里没有的，显示为未启用，方便勾选。
 *
 * `executable` 跟随 **Provider 的可用性**（凭据/配置就绪）：已注册但不可执行的 Provider（例如还没配
 * API Key 的 RunningHub）模型照样列出来（要能预填策略），但必须标成不可执行——它们的模型进不了
 * catalog，画布上根本选不到。
 *
 * 注册表内模型带 `extensionId`：设置页靠它把没有 `providers.<id>` 配置段的 Provider（例如
 * 「服务端接入」）的模型归到自己的卡片。`enabled` 仍然是本机运营策略事实（策略未初始化时视为启用），
 * 模型是否可用以它为准；策略历史行没有该字段（旧宿主只能按 providerId 归组）。
 */
export function projectGenerationModelViews(
  providers: readonly GenerationProvider[],
  snapshot: ReturnType<GenerationModelPolicyStore["snapshot"]>
): GenerationModelPolicyView[] {
  const policyByKey = new Map(snapshot.models.map((model) => [model.modelKey, model]));
  const seen = new Set<string>();
  const models: GenerationModelPolicyView[] = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      const modelKey = `${provider.providerId}:${model.providerModelId}`;
      seen.add(modelKey);
      const policy = policyByKey.get(modelKey);
      const tombstone = policy?.tombstone === true;
      models.push({
        modelKey,
        providerId: provider.providerId,
        modelType: model.modelType,
        title: policy?.title || model.title || model.providerModelId,
        enabled: tombstone ? false : policy ? policy.enabled : !snapshot.initialized,
        isDefault: policy?.isDefault === true,
        ...(policy?.order !== undefined ? { order: policy.order } : {}),
        ...(policy?.taskTimeoutMs !== undefined ? { taskTimeoutMs: policy.taskTimeoutMs } : {}),
        ...(policy?.interaction ? { interaction: policy.interaction } : {}),
        ...(model.notice ? { notice: model.notice } : {}),
        ...(tombstone ? { tombstone: true } : {}),
        executable: provider.available && model.executable !== false,
        extensionId: provider.extensionId
      });
    }
  }
  const registeredProviderIds = new Set(providers.map((provider) => provider.providerId));
  for (const policy of snapshot.models) {
    if (seen.has(policy.modelKey)) continue;
    const providerId = policy.modelKey.split(":")[0] ?? "";
    // Provider 还在、只是不再提供这个 id（例如 Ark 从 seedance2_0 换成公开 Model ID）。
    // 策略里的旧行没有类型，不能编成图像。
    if (registeredProviderIds.has(providerId)) continue;
    // 策略历史行没有 extensionId：旧宿主只能按 providerId 归组。
    models.push({
      modelKey: policy.modelKey,
      providerId,
      modelType: "image",
      ...(policy.title ? { title: policy.title } : {}),
      enabled: policy.enabled && policy.tombstone !== true,
      isDefault: policy.isDefault === true,
      ...(policy.order !== undefined ? { order: policy.order } : {}),
      ...(policy.taskTimeoutMs !== undefined ? { taskTimeoutMs: policy.taskTimeoutMs } : {}),
      ...(policy.interaction ? { interaction: policy.interaction } : {}),
      ...(policy.tombstone ? { tombstone: true } : {}),
      executable: false
    });
  }
  models.sort((a, b) => a.modelType.localeCompare(b.modelType) || (a.title ?? a.modelKey).localeCompare(b.title ?? b.modelKey));
  return models;
}

/**
 * 任务目录修订（`catalogRevision`）：浏览器用它使已打开画布的目录缓存失效（远端 Provider
 * 新增模型后无需刷新页面）。
 *
 * 懒取 `ctx.get("task")` 而不是注入：task 已经 inject generation，再反过来注入会成环。
 * 插件树里 task 尚未装载（或独立装配 generation）时回 0，表示「没有这个信号」（旧宿主语义）。
 */
export function readTaskCatalogRevision(ctx: Pick<HostContext, "get">): number {
  try {
    return ctx.get("task")?.catalogRevision() ?? 0;
  } catch {
    return 0;
  }
}

/**
 * `GET /api/generation-models` 的公开快照：策略视图 + 任务目录修订（不含秘密）。
 *
 * 目录修订由 Task Service 的轻量读取提供：Provider 注册/可用性/模型描述版本变化时单调前进，
 * 已打开的画布据此使目录缓存失效（浏览器本来就在轮询这个快照，不新增目录轮询）。
 */
export function buildGenerationModelsSnapshot(
  ctx: Pick<HostContext, "get">,
  providers: readonly GenerationProvider[],
  snapshot: ReturnType<GenerationModelPolicyStore["snapshot"]>
): GenerationModelsSnapshot {
  return {
    revision: snapshot.revision,
    initialized: snapshot.initialized,
    models: projectGenerationModelViews(providers, snapshot),
    catalogRevision: readTaskCatalogRevision(ctx)
  };
}

function createModelsApi(ctx: HostContext, generation: HostGenerationService, policy: GenerationModelPolicyStore, cached: GenerationModelPolicyView[]) {
  const view = () => {
    const providers=generation.list();
    const snapshot=policy.snapshot();
    const value=buildGenerationModelsSnapshot(ctx,providers,snapshot);
    value.models=mergeRuntimeModelViews(value.models,cached,providers,snapshot);
    return value;
  };
  return createGenerationModelsApiHandler({
    authenticator: ctx.access.authenticator,
    accessEnforcer: ctx.access.accessEnforcer,
    snapshot: async () => view(),
    write: async (input) => {
      const known = modelKeys(generation);
      const result = policy.commit({ expectedRevision: input.expectedRevision, models: input.models, knownModelKeys: known });
      if (!result.ok) {
        if (result.code === "revision-conflict") {
          return { ok: false, code: "revision-conflict", message: "配置已被其它管理员修改", currentRevision: result.currentRevision };
        }
        return { ok: false, code: "config-invalid", message: result.message };
      }
      return { ok: true, revision: result.revision, snapshot: view() };
    },
    logger: ctx.log.scope("generation-models")
  });
}
