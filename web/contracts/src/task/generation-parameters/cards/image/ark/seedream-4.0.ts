/**
 * Seedream 4.0（火山方舟 / 即梦）。
 *
 * 官方只给了一组像素值、**没有按档位拆分的比例表**，所以这张卡片没有 `sizes`：面板不提供
 * 比例控件（选了也兑现不了），宽高比交给提示词。输出格式只有 jpeg，没有透明背景。
 */
import { MB, imageCard } from "../../../card.js";

export const seedream40 = imageCard({
  id: "seedream-4.0",
  title: "Seedream 4.0",
  vendor: "ark",
  providerModelId: "doubao-seedream-4-0-250828",
  docs: "https://docs.volcengine.com/docs/ark/seedream-4-0-5-0?lang=zh",
  note: "4.0：只有档位、没有比例表，宽高比交给提示词",
  keeps: ["prompt", "referencesImage", "resolution", "outputFormat"],
  narrow: { outputFormat: { default: "jpeg", values: ["jpeg"] } },
  seedream: {
    aliases: ["seedream-4.0", "seedream-image-4", "doubao-seedream-4.0"],
    prefixes: ["seedream-4", "seedream-image-4", "doubao-seedream-4"],
    resolutions: ["1K", "2K", "4K"],
    defaultResolution: "2K",
    sizes: {},
    aspectRatios: [],
    pixelWindow: {
      minTotalPixels: 921_600,
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
