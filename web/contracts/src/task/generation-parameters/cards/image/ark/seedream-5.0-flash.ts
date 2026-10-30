/**
 * Seedream 5.0 Flash（火山方舟 / 即梦）。
 *
 * 档位与 Pro 相同（1K / 1.5K / 2K，网关未收窄），透明背景也是同一套官方语义。
 * 差异只在模型本身，不在参数形状上——所以这张卡片与 Pro 只差 id / 标题 / 文档锚点。
 */
import { MB, imageCard } from "../../../card.js";
import {
  SEEDREAM_ASPECT_RATIOS,
  seedreamSizeTable
} from "./seedream-spec.js";

export const seedream50Flash = imageCard({
  id: "seedream-5.0-flash",
  title: "Seedream 5.0 Flash",
  vendor: "ark",
  providerModelId: "doubao-seedream-5-0-flash-260915",
  docs: "https://docs.volcengine.com/docs/ark/seedream-5-0-pro?lang=zh",
  note: "即梦 Flash：档位与 Pro 相同，支持透明背景",
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
    aliases: ["seedream-5-flash", "doubao-seedream-5.0-flash", "doubao-seedream-5-0-flash"],
    prefixes: ["seedream-5-flash", "seedream-image-5-flash", "doubao-seedream-5-0-flash"],
    resolutions: ["1K", "1.5K", "2K"],
    defaultResolution: "2K",
    sizes: seedreamSizeTable("1K", "1.5K", "2K"),
    aspectRatios: SEEDREAM_ASPECT_RATIOS,
    pixelWindow: {
      minTotalPixels: 921_600,
      maxTotalPixels: 4_624_220,
      minAspectRatio: 1 / 16,
      maxAspectRatio: 16
    },
    transparentBackground: true
  },
  limits: {
    promptMaxChars: 800,
    references: { image: { min: 0, max: 10, maxBytesPerItem: 10 * MB } }
  }
});
