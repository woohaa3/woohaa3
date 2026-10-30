/**
 * 生成参数预设卡片 · 查看页夹具
 *
 * **数据不在这里**：最大集合、类型预设、Provider 卡片与约束都来自
 * `@woohaa3/contracts` 的 `generation-parameters`（按「类型 / 厂商 / 模型」组织的卡片目录）。
 * 本文件只补两件查看页需要、
 * 而契约不该管的事：
 *
 * 1. 部署级上限（取 `CANVAS_TASK_LIMITS` 的真实值，与生产一致）；
 * 2. 把卡片合成 `ExecutionPanel` 的 `modelConfig`（走生产投影 `projectParameterFields`）。
 *
 * 这样「查看页看到的」与「生产契约定义的」是同一份数据：改 contracts 里的卡片，
 * story 立刻跟着变，不存在两份会漂移的预设施。
 */
import {
  BUILTIN_PRESET_CARDS,
  CANVAS_TASK_LIMITS,
  composePresetCard,
  effectiveModelLimits,
  presetCardsOf,
  type CanvasTaskCatalogModel,
  type DeployLimits,
  type EffectiveModelLimits,
  type PresetCard,
  type PresetModelType
} from "@woohaa3/contracts";
import type {
  ExecutionPanelModelConfig,
  ExecutionPanelParameterField
} from "../../../../frontend/src/cordis/plugins/task-execution/execution-panel/index.js";
import {
  projectParameterDefaults,
  projectParameterFields
} from "../../../../frontend/src/cordis/plugins/task-execution/parameter-projection.js";

/** 部署级上限：直接取契约常量，避免查看页与生产各写一份。 */
export const SHOWCASE_DEPLOY_LIMITS: DeployLimits = {
  promptMaxChars: CANVAS_TASK_LIMITS.promptMaxChars,
  totalReferences: CANVAS_TASK_LIMITS.maxReferences,
  maxBytesPerItem: CANVAS_TASK_LIMITS.maxImageOutputBytes
};

export type ComposedEntry = {
  card: PresetCard;
  model: CanvasTaskCatalogModel;
  /** 类型预设里有、这张卡片剪掉的键。 */
  dropped: readonly string[];
  /** 与部署级取 min 之后的生效约束；未声明时为 null。 */
  limits: EffectiveModelLimits | null;
};

export type ShowcaseCardSet = {
  config: ExecutionPanelModelConfig;
  entries: ReadonlyMap<string, ComposedEntry>;
};

/** 把一组卡片装配成 `ExecutionPanel` 需要的 modelConfig（只走生产投影）。 */
export function buildCardSet(cards: readonly PresetCard[]): ShowcaseCardSet {
  const entries = new Map<string, ComposedEntry>();
  const parameterSchemaByModel: Record<string, ExecutionPanelParameterField[]> = {};
  const defaultsByModel: Record<string, Record<string, unknown>> = {};
  const modelOptions: Array<{ value: string; label: string; detail?: string; provider?: string }> = [];

  for (const card of cards) {
    const composed = composePresetCard(card);
    const model = composed.model;
    entries.set(model.modelKey, {
      card,
      model,
      dropped: composed.dropped,
      limits: effectiveModelLimits(composed.limits, SHOWCASE_DEPLOY_LIMITS)
    });
    parameterSchemaByModel[model.modelKey] = projectParameterFields(model);
    defaultsByModel[model.modelKey] = projectParameterDefaults(model);
    modelOptions.push({
      value: model.modelKey,
      label: card.title,
      ...(card.note !== undefined ? { detail: card.note } : {}),
      provider: card.providerId
    });
  }

  return {
    config: {
      modelOptions,
      defaultModel: modelOptions[0]?.value ?? "",
      parameterSchemaByModel,
      defaultsByModel
    },
    entries
  };
}

/** 按模型类型取卡片并装配。 */
export function buildCardSetFor(modelType: PresetModelType): ShowcaseCardSet {
  return buildCardSet(presetCardsOf(BUILTIN_PRESET_CARDS, modelType));
}

/** 全部内置卡片（用于「最大集合」总览）。 */
export const ALL_CARDS: readonly PresetCard[] = BUILTIN_PRESET_CARDS;