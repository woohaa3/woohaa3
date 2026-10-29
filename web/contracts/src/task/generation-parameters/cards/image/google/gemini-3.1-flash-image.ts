/**
 * Gemini 3.1 Flash Image（Google）。
 *
 * 原生 `aspect_ratio` + `image_size`；没有质量与数量档位。
 */
import { MB, imageCard } from "../../../card.js";

export const gemini31FlashImage = imageCard({
  id: "gemini-3.1-flash-image",
  title: "Gemini 3.1 Flash Image",
  vendor: "google",
  providerModelId: "gemini-3.1-flash-image",
  docs: "https://ai.google.dev/gemini-api/docs/image-generation",
  note: "原生 aspect_ratio + image_size；没有质量与数量档位",
  keeps: ["prompt", "referencesImage", "aspectRatio", "resolution"],
  limits: {
    promptMaxChars: 48000,
    references: { image: { min: 0, max: 14, maxBytesPerItem: 20 * MB } }
  }
});
