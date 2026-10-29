/**
 * GPT Image 2.5 Flare。
 *
 * Azure 文档里的 GPT-Image-2.5 变体：与基础 2.5 共用同一套参数与质量档位
 * （`low` / `medium` / `high` / `xhigh` / `max` / `auto`），只按 id 区分。
 * 参数真相在 `imageFamilyParameters` 的 gpt-image 家族，这里只声明身份与边界。
 */
import { MB, imageCard } from "../../../card.js";

export const gptImage25Flare = imageCard({
  id: "gpt-image-2.5-flare",
  title: "GPT Image 2.5 Flare",
  vendor: "openai",
  providerModelId: "gpt-image-2.5-flare",
  docs: "https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/dall-e",
  note: "最快的一档：高质量日常出图，同样支持透明背景",
  keeps: [
    "prompt",
    "referencesImage",
    "aspectRatio",
    "resolution",
    "quality",
    "n",
    "background",
    "outputFormat"
  ],
  limits: {
    promptMaxChars: 32000,
    references: { image: { min: 0, max: 16, maxBytesPerItem: 20 * MB } }
  }
});
