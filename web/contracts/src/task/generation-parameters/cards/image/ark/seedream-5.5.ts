/**
 * Seedream 5.5（火山方舟 / 即梦）。
 *
 * 当前一代主模型，参数形状与 5.0 pro 同族（档位 1K / 1.5K / 2K，同一张官方像素表），
 * 但多了两个实际差异：
 *
 * 1. **透明背景可以从文生图发起**（`transparentBackgroundFromText`）—— 5.0 pro / flash 只能
 *    「图生图 + 1 张透明 PNG」，5.5 支持文生图与图生图出原生 RGBA；
 * 2. **图层拆分可带 `layer_decomposition_options`**：单次最多 100 张（1 底图 + 99 图层），
 *    可设 `max_images` 与 `text_recognition`。5.0 pro / flash 只能光一个布尔值。
 *
 * 同时它是**唯一不支持**联网搜索、流式输出与极速提示词优化的版本（官方模型参数表）。
 */
import { MB, imageCard } from "../../../card.js";
import {
  SEEDREAM_ASPECT_RATIOS,
  seedreamSizeTable
} from "./seedream-spec.js";

export const seedream55 = imageCard({
  id: "seedream-5.5",
  title: "Seedream 5.5",
  vendor: "ark",
  providerModelId: "doubao-seedream-5-5-261028",
  docs: "https://docs.volcengine.com/docs/ark/seedream-5-5?lang=zh",
  note: "即梦 5.5：文生图也能出原生 RGBA；图层拆分最多 100 张",
  keeps: [
    "prompt",
    "referencesImage",
    "aspectRatio",
    "resolution",
    "background",
    "outputFormat"
  ],
  narrow: { outputFormat: { default: "jpeg", values: ["jpeg", "png"] } },
  seedream: {
    aliases: ["seedream-5.5", "seedream-5-5", "doubao-seedream-5.5"],
    prefixes: ["seedream-5.5", "seedream-5-5", "seedream-image-5.5", "doubao-seedream-5-5"],
    resolutions: ["1K", "1.5K", "2K"],
    defaultResolution: "2K",
    sizes: seedreamSizeTable("pro", "1K", "1.5K", "2K"),
    aspectRatios: SEEDREAM_ASPECT_RATIOS,
    pixelWindow: {
      minTotalPixels: 921_600,
      maxTotalPixels: 4_624_220,
      minAspectRatio: 1 / 16,
      maxAspectRatio: 16
    },
    transparentBackground: true,
    features: {
      outputFormatParameter: true,
      // 官方：5.5 只有标准模式。
      promptOptimizeModes: ["standard"],
      // 文生图 + 图生图都支持原生 RGBA（5.0 pro / flash 仅限图生图单张透明 PNG）。
      transparentBackgroundFromText: true,
      layerDecompositionOptions: {
        minImages: 2,
        maxImages: 100,
        defaultMaxImages: 30,
        textRecognition: true
      },
      streaming: false,
      webSearch: false
    }
  },
  limits: {
    promptMaxChars: 800,
    references: { image: { min: 0, max: 10, maxBytesPerItem: 10 * MB } }
  }
});
