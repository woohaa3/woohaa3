/**
 * catalog → 面板配置投影（change: add-image-text-node-execution，任务 3.5 / design D4 / D12）。
 *
 * 站点**不维护模型硬编码清单**：面板的模型选项与参数模式全部由 `/api/pptask/catalog`
 * 返回的 `inputSchema` / `defaultInput` 投影而来（showcase 里的 fixture 只服务组件展示）。
 *
 * 投影规则（spec `canvas-node-execution`「模型与参数的目录投影」）：
 * - `enum` → select；
 * - number 且带 minimum/maximum → slider，否则 number；
 * - boolean → checkbox；
 * - `prompt` / `urls` 不进参数表：前者是面板自己的提示词框，后者是参考输入能力；
 * - schema `default` 与 `defaultInput` 一起作为默认参数。
 *
 * 参数表本身由 `parameter-projection.ts` 统一投影（与 generic 面板共用）；本文件只负责
 * 站点面板的模型筛选、默认模型与参考输入能力。
 */
import type { ExecutionPanelModelConfig, ExecutionPanelParameterField } from "../../ui/index.js";
import { TASK_KIND_TO_MODEL_TYPE,
  catalogModelBindings,
  summarizeBindings,
  type CanvasTaskCatalog,
  type CanvasTaskCatalogModel,
  type ReferenceInputCapability } from "@woohaa3/contracts";
import type { NodePanelKind } from "./node-panel-registry.js";
import { projectParameterDefaults, projectParameterFields } from "./parameter-projection.js";

/** 专用 Seedance 视频交互：core generic 投影不得把它当作普通视频模型展示。 */
export const SEEDANCE_VIDEO_INTERACTION = "seedance-video";

export function panelModelConfigForCatalog(
  catalog: CanvasTaskCatalog,
  panelKind: NodePanelKind
): ExecutionPanelModelConfig {
  const models = modelsForPanel(catalog, panelKind);
  const modelType = TASK_KIND_TO_MODEL_TYPE[panelKind];
  const parameterSchemaByModel: Record<string, ExecutionPanelParameterField[]> = {};
  const defaultsByModel: Record<string, Record<string, unknown>> = {};

  for (const model of models) {
    parameterSchemaByModel[model.modelKey] = projectParameterFields(model);
    defaultsByModel[model.modelKey] = projectParameterDefaults(model);
  }

  const configuredDefault = catalog.defaultModels?.[modelType];
  const defaultModel =
    configuredDefault && models.some((model) => model.modelKey === configuredDefault)
      ? configuredDefault
      : models[0]?.modelKey ?? "";

  return {
    modelOptions: models.map(modelOptionForCatalog),
    defaultModel,
    parameterSchemaByModel,
    defaultsByModel
  };
}

/** 模型选项只投影名称与提供方；参数能力由参数表和参考输入控件呈现。 */
export function modelOptionForCatalog(model: CanvasTaskCatalogModel): ExecutionPanelModelConfig["modelOptions"][number] {
  return {
    value: model.modelKey,
    label: model.title || model.providerModelId,
    provider: model.providerId
  };
}

export function modelsForPanel(
  catalog: CanvasTaskCatalog,
  panelKind: NodePanelKind
): CanvasTaskCatalogModel[] {
  return allModelsForPanel(catalog, panelKind).filter(
    (model) => model.interaction.id !== SEEDANCE_VIDEO_INTERACTION
  );
}

/** 该 panel 类型下的全部 catalog 模型（含专用交互；Host 解析交互时使用）。 */
export function allModelsForPanel(
  catalog: CanvasTaskCatalog,
  panelKind: NodePanelKind
): CanvasTaskCatalogModel[] {
  const modelType = TASK_KIND_TO_MODEL_TYPE[panelKind];
  return catalog.models.filter((model) => model.modelType === modelType);
}

/**
 * 取某个模型的参考输入能力。
 *
 * catalog 里没有这个模型时返回一个「不接受参考输入」的能力：面板据此显示 blocking reason，
 * 而不是拿另一模型的限制去校验（那会给出误导性的原因）。
 */
export function capabilityForModel(
  catalog: CanvasTaskCatalog,
  panelKind: NodePanelKind,
  modelKey?: string
): ReferenceInputCapability | null {
  const models = allModelsForPanel(catalog, panelKind);
  if (models.length === 0) return null;
  const model = modelKey
    ? models.find((entry) => entry.modelKey === modelKey)
    : models[0];
  if (!model) return null;
  // bindings 是唯一权威输入契约。
  return summarizeBindings(catalogModelBindings(model));
}

/** catalog 级别的阻止原因（不可用、没有可用模型）。 */
export function catalogBlockingReasons(catalog: CanvasTaskCatalog | null): string[] {
  if (!catalog) return ["任务目录尚未加载"];
  if (!catalog.available) {
    return [catalog.reason ?? "暂无可用模型，请检查 Provider 配置"];
  }
  if (catalog.models.length === 0) return ["任务目录中没有可用模型"];
  return [];
}

/**
 * 目录「尚未就绪」的阻止原因（loading / error）。
 *
 * 与 `catalogBlockingReasons` 分开：后者描述**已加载的目录内容**问题，这里描述
 * **目录还没拿到**。两者文案不同，避免把加载失败误报成「没有可用模型」。
 */
export function catalogStateBlockingReasons(
  state: { status: "loading" | "ready" | "error"; error?: string }
): string[] {
  if (state.status === "loading") return ["任务目录尚未加载"];
  if (state.status === "error") return [`任务目录加载失败：${state.error ?? "原因未知"}`];
  return [];
}
