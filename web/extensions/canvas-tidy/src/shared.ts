/**
 * 一键整理的配置定义（两端共用）。
 *
 * 配置是**宿主持久化的事实**：写在宿主配置文件（`woohaa.config.yml`）的
 * `extensions.canvas-tidy.*` 段里，由宿主读出、校验、热重载后交给后端插件的 `apply`。
 * 不是浏览器本地偏好——换浏览器、换设备、重装前端产物都还有同一份配置。
 *
 * 唯一声明处在这里：`extension.json` 的 `hostPlugin` 指向后端入口，后端用它构造
 * `defineConfigSchema`；前端设置面板经宿主 `/api/settings` 读写同一批键，键名从本文件取，
 * 不各写一份字面量。
 */
import { defineConfigSchema } from "@woohaa3/contracts";

export const CANVAS_TIDY_PLUGIN_ID = "canvas-tidy";

/** 配置段前缀：所有键都挂在 `extensions.canvas-tidy.` 下。 */
export const CANVAS_TIDY_CONFIG_PREFIX = `extensions.${CANVAS_TIDY_PLUGIN_ID}`;

/**
 * 配置项。
 *
 * 全部 `reload: "hot"`：这些是排布手感参数，改了只影响下一次点「一键整理」，不需要重启扩展。
 * 全部带 `default`，缺省行为与没有配置项时完全一致。
 */
export const CANVAS_TIDY_CONFIG = defineConfigSchema({
  gap: {
    kind: "integer",
    default: 40,
    min: 8,
    max: 200,
    reload: "hot",
    label: "卡片间距",
    description: "同列/同行相邻卡片之间留多少空白（世界单位）。整理时用它计算行距。"
  },
  columnGapRatio: {
    kind: "integer",
    // 用「百分比」表达小数：integer 是宿主配置面唯一支持范围的数值类型。
    default: 250,
    min: 100,
    max: 600,
    reload: "hot",
    label: "列间距（占卡片间距的百分比）",
    description: "流程里相邻两列之间的距离 = 卡片间距 × 该百分比。太小会把连线压成短线，读不出方向。"
  },
  shrinkOversized: {
    kind: "boolean",
    default: true,
    reload: "hot",
    label: "缩回过大的卡片",
    description: "整理时把明显超出标准尺寸的卡片等比缩回。关闭后整理只移动卡片，不改任何尺寸。"
  },
  maxCardScale: {
    kind: "integer",
    default: 100,
    min: 100,
    max: 300,
    reload: "hot",
    label: "尺寸容差（占标准尺寸的百分比）",
    description: "卡片超过「标准尺寸 × 该百分比」才缩；100 表示严格按标准尺寸，调大可容忍更大的卡片。"
  },
  revealAfterTidy: {
    kind: "boolean",
    default: true,
    reload: "hot",
    label: "定位到整理结果",
    description: "整理完成后把视口移到这批卡片上；关闭则保持当前视野。"
  }
});

export type CanvasTidyConfigValues = {
  gap: number;
  columnGapRatio: number;
  shrinkOversized: boolean;
  maxCardScale: number;
  revealAfterTidy: boolean;
};

/** 把配置值换算成规划层用的选项（百分比 → 倍数）。 */
export function tidyPlanOptionsFromConfig(config: Partial<CanvasTidyConfigValues>): {
  gap: number;
  columnGapRatio: number;
  shrinkOversized: boolean;
  maxCardScale: number;
} {
  return {
    gap: config.gap ?? 40,
    columnGapRatio: (config.columnGapRatio ?? 250) / 100,
    shrinkOversized: config.shrinkOversized ?? true,
    maxCardScale: (config.maxCardScale ?? 100) / 100
  };
}
