/**
 * Seedream 5.0 Flash（火山方舟 / 即梦）。
 *
 * 档位与 Pro 不同（保留 1.5K），仍然只有 `size`——差异由家族表分别给出。
 */
import { MB, imageCard } from "../../../card.js";

export const seedream50Flash = imageCard({
  id: "seedream-5.0-flash",
  title: "Seedream 5.0 Flash",
  vendor: "ark",
  providerModelId: "doubao-seedream-5-0-flash-260915",
  docs: "https://docs.volcengine.com/docs/ark/seedream-5-0-pro?lang=zh",
  note: "即梦 Flash：档位与 Pro 不同，仍然只有 size",
  keeps: ["prompt", "referencesImage", "aspectRatio", "resolution", "outputFormat"],
  narrow: { outputFormat: { default: "jpeg", values: ["jpeg", "png"] } },
  limits: {
    promptMaxChars: 800,
    references: { image: { min: 0, max: 10, maxBytesPerItem: 10 * MB } }
  }
});
