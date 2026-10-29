/**
 * Seedream 4.5（火山方舟 / 即梦）。
 *
 * 4.5 没有按档位的比例表：比例交给提示词，面板只给分辨率档位（家族表里 `sizes` 为空
 * 时不会暴露比例控件）。输出格式只有 jpeg。
 */
import { MB, imageCard } from "../../../card.js";

export const seedream45 = imageCard({
  id: "seedream-4.5",
  title: "Seedream 4.5",
  vendor: "ark",
  providerModelId: "doubao-seedream-4-5-251128",
  docs: "https://docs.volcengine.com/docs/ark/seedream-4-0-5-0?lang=zh",
  note: "4.5 没有按档位的比例表，比例交给提示词",
  keeps: ["prompt", "referencesImage", "aspectRatio", "resolution", "outputFormat"],
  narrow: { outputFormat: { default: "jpeg", values: ["jpeg"] } },
  limits: {
    promptMaxChars: 800,
    references: { image: { min: 0, max: 14, maxBytesPerItem: 10 * MB } }
  }
});
