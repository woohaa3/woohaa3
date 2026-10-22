/**
 * 模型目录构建（change: add-image-text-node-execution，任务 5.2 / 5.11–5.13，design D12 / D13）。
 *
 * 两件事分开：
 * - **能力**来自 provider 的注册表 + `describe()`（`inputSchema` / `defaultInput` / 参考输入上限）；
 * - **启用集合与运营覆盖**来自仓库内模型配置文件。
 *
 * `describe()` 在 litellm 实现里是纯静态函数（不发网络请求），所以这里既不会泄漏上游响应头，
 * 也不会因为上游抖动让目录不可用。
 *
 * 不静默降级：配置里出现注册表不认识的 id、或已配置模型无法描述，都让 catalog 返回
 * 不可用 + 原因，而不是返回一个缺了几项的目录 —— 运营必须能确信配置生效了。
 */
import { DEFAULT_TASK_TIMEOUT_MS,
  GENERIC_MODEL_INTERACTION_ID,
  GENERIC_MODEL_INTERACTION_VERSION,
  isGenerationModelCapabilityFacts,
  normalizeInputBindings,
  referenceInputCapabilityFromDescription,
  type CanvasTaskCatalog,
  type CanvasTaskCatalogModel,
  type CanvasTaskInputBinding,
  type CanvasTaskModelType,
  type ModelInteractionDescriptor } from "@woohaa3/contracts";
import { resolveEnabledModels, type ModelsConfig, type ReferenceInputOverride, type ResolvedModel } from "../config/models-config.js";
import type { DescribedModel, TaskCatalogProvider } from "./types.js";

export async function buildCanvasTaskCatalog(
  taskProvider: TaskCatalogProvider,
  modelsConfig: ModelsConfig,
  /**
   * 可选的运营策略解析（change: 2026-10-04-...，任务 1.3/2.2/3.1）。
   * 提供时用它替代 `modelsConfig` 求交（站点持久化策略权威）；否则沿用旧配置。
   */
  resolveSelection?: (registry: ReadonlyArray<{ modelKey: string; providerId: string; providerModelId: string; modelType: CanvasTaskModelType }>) =>
    | { ok: true; models: ResolvedModel[]; defaults: Partial<Record<CanvasTaskModelType, string>> }
    | { ok: false; reason: string }
): Promise<CanvasTaskCatalog> {
  let registry: Array<{ modelKey: string; providerId: string; providerModelId: string; modelType: CanvasTaskModelType }>;
  try {
    registry = taskProvider.listModels();  } catch (error) {
    return unavailable(`读取 provider 模型注册表失败：${errorMessage(error)}`);
  }

  const selection = resolveSelection ? resolveSelection(registry) : resolveEnabledModels(modelsConfig, registry);
  if (!selection.ok) return unavailable(selection.reason);

  const models: CanvasTaskCatalogModel[] = [];
  for (const resolved of selection.models) {
    let description: DescribedModel;
    try {
      description = await taskProvider.describe(resolved.modelKey);
    } catch (error) {
      // 已配置的模型必须可用；失败就整体不可用，避免"少了一个模型但没人知道"。
      return unavailable(`模型 ${resolved.modelKey} 的描述不可用：${errorMessage(error)}`);
    }
    const model = projectModel(resolved, description);
    models.push(model);
  }

  if (models.length === 0) return unavailable("没有启用任何模型");

  return { available: true, models, defaultModels: selection.defaults };
}

/** 受信任默认交互：operator 未配置时的 generic。 */
const DEFAULT_INTERACTION: ModelInteractionDescriptor = {
  id: GENERIC_MODEL_INTERACTION_ID,
  version: GENERIC_MODEL_INTERACTION_VERSION
};

function projectModel(resolved: ResolvedModel, description: DescribedModel): CanvasTaskCatalogModel {
  // catalog 身份来自**注册表**（providerId/providerModelId 不可由 description 覆盖）。
  const interaction: ModelInteractionDescriptor = resolved.interaction ?? DEFAULT_INTERACTION;
  const declared = referenceInputCapabilityFromDescription({
    inputSchema: description.inputSchema,
    defaultInput: description.defaultInput,
    capabilities: description.capabilities
  });
  const override = resolved.referenceInput;
  // 运营覆盖：使用完整 bindings。
  const bindings = applyReferenceOverride(declared.bindings, override);
  // 能力事实：非法形状整体丢弃，不影响可执行性与 bindings（缺省语义 = 未声明）。
  const capabilityFacts = isGenerationModelCapabilityFacts(description.capabilityFacts)
    ? description.capabilityFacts
    : undefined;

  return {
    modelKey: resolved.modelKey,
    providerId: resolved.providerId,
    providerModelId: resolved.providerModelId,
    modelType: resolved.modelType,
    title: resolved.title ?? description.title ?? resolved.providerModelId,
    interaction: { ...interaction },
    inputSchema: description.inputSchema ?? {},
    defaultInput: description.defaultInput ?? {},
    // 唯一输入契约：bindings。
    bindings,
    ...(capabilityFacts ? { capabilityFacts } : {}),
    taskTimeoutMs: resolved.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS[resolved.modelType],
    // 模型级 prompt 要求与取消能力（change: 2026-10-04-...，任务 3.4 / design D4/D6）。
    promptRequirement: description.promptRequirement ?? "required",
    cancel: description.cancel ?? "local",
    ...(description.capabilities ? { capabilities: description.capabilities } : {})
  };
}

/**
 * 应用运营 `referenceInput` 覆盖。当前契约只接受完整 `bindings`；
 * 旧字段（acceptsImages/roles/maxItems/mediaTypes）不再生效（change:
 * 2026-10-07-remove-residual-compatibility）。
 */
function applyReferenceOverride(
  declared: CanvasTaskInputBinding[],
  override: ReferenceInputOverride | undefined
): CanvasTaskInputBinding[] {
  if (!override) return declared;
  if (Array.isArray(override.bindings) && override.bindings.length > 0) {
    return normalizeInputBindings(override.bindings);
  }
  return declared;
}

function unavailable(reason: string): CanvasTaskCatalog {
  return { available: false, reason, models: [], defaultModels: {} };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
