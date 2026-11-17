/**
 * Seedream 4.0（火山方舟 / 即梦）。
 *
 * 官方文档当前已给出 4.0 的「档位 × 宽高比」映射表（1K / 2K / 4K），所以这张卡片也有 `sizes`
 * 与比例控件。注意 4.0 的 1K 与 pro 族不同（16:9 = 1280x720、21:9 = 1512x648），
 * 2K / 4K 与 lite 族一致，因此用 `seedreamSizeTable("4.0", ...)`。
 * 输出格式只有 jpeg，且**不认 `output_format` 参数**（传了直接 400）。
 */
import { MB, imageCard } from "../../../card.js";
import {
  SEEDREAM_ASPECT_RATIOS,
  seedreamSizeTable
} from "./seedream-spec.js";

export const seedream40 = imageCard({
  id: "seedream-4.0",
  title: "Seedream 4.0",
  vendor: "ark",
  providerModelId: "doubao-seedream-4-0-250828",
  docs: "https://docs.volcengine.com/docs/ark/seedream-4-0-5-0?lang=zh",
  note: "4.0：档位 1K / 2K / 4K，1K 为 4.0 专属像素表；只出 jpeg",
  keeps: ["prompt", "referencesImage", "aspectRatio", "resolution", "outputFormat"],
  narrow: { outputFormat: { default: "jpeg", values: ["jpeg"] } },
  seedream: {
    aliases: ["seedream-4.0", "seedream-image-4", "doubao-seedream-4.0"],
    prefixes: ["seedream-4", "seedream-image-4", "doubao-seedream-4"],
    resolutions: ["1K", "2K", "4K"],
    defaultResolution: "2K",
    sizes: seedreamSizeTable("4.0", "1K", "2K", "4K"),
    aspectRatios: SEEDREAM_ASPECT_RATIOS,
    pixelWindow: {
      minTotalPixels: 921_600,
      maxTotalPixels: 16_777_216,
      minAspectRatio: 1 / 16,
      maxAspectRatio: 16
    },
    features: {
      // 4.0 只出 JPEG，且不认 `output_format` 字段。
      outputFormatParameter: false,
      // 4.0 是除 5.0 pro 外唯一有「极速模式」的版本。
      promptOptimizeModes: ["standard", "fast"],
      streaming: true,
      webSearch: false
    }
  },
  limits: {
    promptMaxChars: 800,
    references: { image: { min: 0, max: 14, maxBytesPerItem: 10 * MB } }
  }
});
