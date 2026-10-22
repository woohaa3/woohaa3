/**
 * 生成模型运营策略解析
 * （change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 1.3/2.2/3.1 / design D2）。
 *
 * 把「Provider 注册的能力资源」与「站点持久化运营策略」求交，得到可执行的模型索引：
 * - 未初始化：全开（空集合 = 默认全开），并可由调用方幂等导入旧配置；
 * - 已初始化：只保留策略中 `enabled && !tombstone` 且注册表里存在的 modelKey；空集合保持关闭；
 * - 默认模型：每 modelType 至多一个，冲突稳定拒绝（由 commit 侧校验）。
 *
 * 纯函数、无副作用。
 */
import type { GenerationModelStoreSnapshot } from "./generation-model-store.js";

export type RegisteredModelIdentity = {
  modelKey: string;
  providerId: string;
  providerModelId: string;
  modelType: string;
};

export type ResolvedGenerationModel = RegisteredModelIdentity & {
  enabled: boolean;
  isDefault: boolean;
  title?: string;
  order?: number;
  taskTimeoutMs?: number;
  interaction?: { id: string; version: number };
};

export type ResolveGenerationModelsResult =
  | { ok: true; models: ResolvedGenerationModel[]; defaults: Record<string, string> }
  | { ok: false; reason: string };

/**
 * Provider 的模型启用集合权威来源（与 `GenerationProvider.selectionAuthority` 同字面量）。
 *
 * - `local`：站点运营策略（本文件入参 `policy`）是启用集合的权威；
 * - `server`：Provider 自己的目录（远端托管生成）是权威，本机策略 MUST NOT 过滤其模型。
 */
export type GenerationSelectionAuthority = "local" | "server";

/**
 * 解析可执行模型集合。
 *
 * @param registered 注册表里可执行的资源（已过滤不可用 Provider）
 * @param policy 站点运营策略快照
 * @param providerAuthority Provider 的启用权威来源（缺省一律 `local`）。
 *   `server` 的 Provider 模型无条件进入结果（enabled=true），策略行只提供展示性覆盖
 *   （title/order/taskTimeoutMs/interaction/isDefault），既不参与过滤也不被本函数写回。
 *
 * change: 2026-10-07-remove-residual-compatibility —— 删除旧 `pptask.models` 导入与
 * 未初始化时的 legacy 白名单回退。未初始化时全开（空集合 = 默认全开）；已初始化时策略为权威。
 * change: 2026-10-20-reserve-remote-generation-provider —— `server` 权威旁路本地策略。
 */
export function resolveGenerationModels(input: {
  registered: readonly RegisteredModelIdentity[];
  policy: GenerationModelStoreSnapshot;
  providerAuthority?: Readonly<Record<string, GenerationSelectionAuthority>>;
}): ResolveGenerationModelsResult {

  // 未初始化：全开（无 legacy 白名单）。
  if (!input.policy.initialized) {
    return { ok: true, models: input.registered.map((resource) => ({ ...resource, enabled: true, isDefault: false })), defaults: {} };
  }

  // 已初始化：策略为权威；空集合即关闭。server 权威的 Provider 不受此约束。
  const policyByKey = new Map(input.policy.models.map((model) => [model.modelKey, model]));
  const models: ResolvedGenerationModel[] = [];
  for (const resource of input.registered) {
    const model = policyByKey.get(resource.modelKey);
    const authority = input.providerAuthority?.[resource.providerId] ?? "local";
    if (authority === "server") {
      // 远端权威目录：模型可用性由服务端决定，本机策略只保留展示/排序覆盖。
      // tombstone 是本地运营「隐藏」意图，对远端权威不生效（否则又变成策略过滤）。
      models.push({
        ...resource,
        enabled: true,
        isDefault: model?.tombstone === true ? false : model?.isDefault === true,
        ...(model?.title ? { title: model.title } : {}),
        ...(model?.order !== undefined ? { order: model.order } : {}),
        ...(model?.taskTimeoutMs !== undefined ? { taskTimeoutMs: model.taskTimeoutMs } : {}),
        ...(model?.interaction ? { interaction: model.interaction } : {})
      });
      continue;
    }
    if (!model || model.tombstone || !model.enabled) continue;
    models.push({
      ...resource,
      enabled: true,
      isDefault: model.isDefault === true,
      ...(model.title ? { title: model.title } : {}),
      ...(model.order !== undefined ? { order: model.order } : {}),
      ...(model.taskTimeoutMs !== undefined ? { taskTimeoutMs: model.taskTimeoutMs } : {}),
      ...(model.interaction ? { interaction: model.interaction } : {})
    });
  }
  return finish(models);
}

function finish(models: ResolvedGenerationModel[]): ResolveGenerationModelsResult {
  const ordered = [...models].sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
  const defaults: Record<string, string> = {};
  for (const model of ordered) {
    if (model.isDefault) defaults[model.modelType] = model.modelKey;
  }
  return { ok: true, models: ordered, defaults };
}
