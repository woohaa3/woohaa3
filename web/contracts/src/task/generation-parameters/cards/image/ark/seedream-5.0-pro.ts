/**
 * Seedream 5.0 Pro（火山方舟 / 即梦）。
 *
 * 即梦没有 `aspect_ratio` 与 `quality`：宽高比只能写进 `size`。档位与像素表由
 * `families/image` 的 seedream 家族给出（网关链路已按 5.0 pro 收窄到 1K / 2K）。
 */
import { MB, imageCard } from "../../../card.js";

export const seedream50Pro = imageCard({
  id: "seedream-5.0-pro",
  title: "Seedream 5.0 Pro",
  vendor: "ark",
  providerModelId: "doubao-seedream-5-0-pro-260628",
  docs: "https://docs.volcengine.com/docs/ark/seedream-5-0-pro?lang=zh",
  note: "即梦：没有 aspect_ratio / quality，宽高比只能写进 size",
  keeps: ["prompt", "referencesImage", "aspectRatio", "resolution", "outputFormat"],
  narrow: { outputFormat: { default: "jpeg", values: ["jpeg", "png"] } },
  limits: {
    promptMaxChars: 800,
    references: { image: { min: 0, max: 10, maxBytesPerItem: 10 * MB } }
  }
});
