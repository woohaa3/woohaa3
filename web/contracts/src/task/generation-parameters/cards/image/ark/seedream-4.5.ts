/**
 * Seedream 4.5（火山方舟 / 即梦）。
 *
 * 4.5 的官方档位是 2K / 4K，有按档位的比例表；输出格式只有 jpeg，也没有透明背景
 * （官方 `background` 的模型列表只到 5.0 pro / flash）。
 */
import { MB, imageCard } from "../../../card.js";
import {
  SEEDREAM_ASPECT_RATIOS,
  seedreamSizeTable
} from "./seedream-spec.js";

export const seedream45 = imageCard({
  id: "seedream-4.5",
  title: "Seedream 4.5",
  vendor: "ark",
  providerModelId: "doubao-seedream-4-5-251128",
  docs: "https://docs.volcengine.com/docs/ark/seedream-4-0-5-0?lang=zh",
  note: "4.5：档位 2K / 4K，只出 jpeg，没有透明背景",
  keeps: ["prompt", "referencesImage", "aspectRatio", "resolution", "outputFormat"],
  narrow: { outputFormat: { default: "jpeg", values: ["jpeg"] } },
  seedream: {
    aliases: ["seedream-4.5", "seedream-image-4.5", "doubao-seedream-4.5"],
    prefixes: ["seedream-4.5", "seedream-4-5", "seedream-image-4.5", "doubao-seedream-4-5"],
    resolutions: ["2K", "4K"],
    defaultResolution: "2K",
    sizes: seedreamSizeTable("2K", "4K"),
    aspectRatios: SEEDREAM_ASPECT_RATIOS,
    pixelWindow: {
      minTotalPixels: 3_686_400,
      maxTotalPixels: 16_777_216,
      minAspectRatio: 1 / 16,
      maxAspectRatio: 16
    }
  },
  limits: {
    promptMaxChars: 800,
    references: { image: { min: 0, max: 14, maxBytesPerItem: 10 * MB } }
  }
});
