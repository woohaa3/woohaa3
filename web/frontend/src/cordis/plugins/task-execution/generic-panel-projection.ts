/**
 * Generic Panel 的 catalog 投影（Model Interaction 专用）
 * （change: 2026-09-29-add-pluggable-model-interactions，任务 4.4）。
 *
 * 从该 panel 类型的 catalog 模型投影 ExecutionPanelModelConfig。这是 generic Plugin 自己的
 * UI 投影；提交参数仍必须通过相同的服务端 inputSchema 校验。
 *
 * 参数表投影与站点节点面板共用 `parameter-projection.ts`；本文件只保留 generic 面板的
 * 默认模型选择。
 */
import {
  TASK_KIND_TO_MODEL_TYPE,
  type CanvasTaskCatalogModel
} from "@woohaa3/contracts";
import type {
  ExecutionPanelModelConfig,
  ExecutionPanelParameterField
} from "./execution-panel/types.js";
import type { NodePanelKind } from "./node-panel-registry.js";
import { modelOptionForCatalog } from "./catalog-projection.js";
import { projectParameterDefaults, projectParameterFields } from "./parameter-projection.js";

export function currentPanelDefaultModelKey(
  models: readonly CanvasTaskCatalogModel[],
  preferred: string
): string {
  if (preferred !== "" && models.some((model) => model.modelKey === preferred)) return preferred;
  return models[0]?.modelKey ?? "";
}

export function projectModelConfig(
  models: readonly CanvasTaskCatalogModel[],
  selected: string,
  fallbackDefault: string
): ExecutionPanelModelConfig {
  const parameterSchemaByModel: Record<string, ExecutionPanelParameterField[]> = {};
  const defaultsByModel: Record<string, Record<string, unknown>> = {};
  for (const model of models) {
    parameterSchemaByModel[model.modelKey] = projectParameterFields(model);
    defaultsByModel[model.modelKey] = projectParameterDefaults(model);
  }
  return {
    modelOptions: models.map(modelOptionForCatalog),
    defaultModel: currentPanelDefaultModelKey(models, selected) || fallbackDefault,
    parameterSchemaByModel,
    defaultsByModel
  };
}

export { TASK_KIND_TO_MODEL_TYPE, type NodePanelKind };
