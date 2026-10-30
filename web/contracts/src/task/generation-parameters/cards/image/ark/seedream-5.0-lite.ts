/**
 * Seedream 5.0 Lite（火山方舟 / 即梦）。
 *
 * 档位 2K / 3K / 4K，有按档位的比例表；output_format 支持 png / jpeg，
 * 但**没有**透明背景（官方 `background` 只列了 5.0 pro / flash）。
 * 组图（`sequential_image_generation`）是 lite 独有的模式，由 Ark 目录声明。
 */
import { MB, imageCard } from "../../../card.js";
import {
  SEEDREAM_ASPECT_RATIOS,
  seedreamSizeTable
} from "./seedream-spec.js";

export const seedream50Lite = imageCard({
  id: "seedream-5.0-lite",
  title: "Seedream 5.0 Lite",
  vendor: "ark",
  providerModelId: "doubao-seedream-5-0-260128",
  docs: "https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh",
  note: "即梦 Lite：档位 2K / 3K / 4K，没有透明背景",
  keeps: ["prompt", "referencesImage", "aspectRatio", "resolution", "outputFormat"],
  narrow: { outputFormat: { default: "jpeg", values: ["jpeg", "png"] } },
  seedream: {
    aliases: ["seedream-5-lite", "seedream-image-5-lite", "doubao-seedream-5-0-lite"],
    // 「doubao-seedream-5-0」用于只带日期后缀、没写 pro/flash/lite 的网关 id（更长前缀仍优先）。
    prefixes: ["seedream-5-lite", "seedream-image-5-lite", "doubao-seedream-5-0-lite", "doubao-seedream-5-0"],
    resolutions: ["2K", "3K", "4K"],
    defaultResolution: "2K",
    sizes: seedreamSizeTable("2K", "3K", "4K"),
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
