/**
 * Nano Banana 2（Google / Gemini 家族别名）。
 *
 * 与 Gemini 家族同一套参数，只是 id 不同——这正是卡片与家族分开的价值：
 * 换一个别名只加一张卡片，参数真相不必再写一遍。
 */
import { MB, imageCard } from "../../../card.js";

export const nanoBanana2 = imageCard({
  id: "nano-banana-2",
  title: "Nano Banana 2",
  vendor: "google",
  providerModelId: "nanobanana-2",
  docs: "https://ai.google.dev/gemini-api/docs/image-generation",
  note: "Gemini 家族的别名：比例 + image_size",
  keeps: ["prompt", "referencesImage", "aspectRatio", "resolution"],
  limits: {
    promptMaxChars: 48000,
    references: { image: { min: 0, max: 14, maxBytesPerItem: 20 * MB } }
  }
});
