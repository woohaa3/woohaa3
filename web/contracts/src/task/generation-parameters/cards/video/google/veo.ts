/**
 * Veo（Google）。
 *
 * 只给横竖两种画幅；时长按 2 秒步长（4 / 6 / 8）。步长由家族给出，翻译层会按它就近对齐
 * ——面板选 5 秒时发出去的是 6 秒，而不是等上游 400。
 */
import { MB, videoCard } from "../../../card.js";

export const veo = videoCard({
  id: "veo",
  title: "Veo",
  vendor: "google",
  providerModelId: "veo-3.1-fast",
  docs: "https://ai.google.dev/gemini-api/docs/veo",
  note: "只给横竖两种画幅；时长按 2 秒步长（4 / 6 / 8）",
  keeps: ["prompt", "referencesImage", "durationSeconds", "aspectRatio", "resolution"],
  limits: {
    promptMaxChars: 2000,
    references: { image: { min: 0, max: 1, maxBytesPerItem: 20 * MB } }
  }
});
