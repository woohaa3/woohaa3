/**
 * GPT Image 2.5（OpenAI）。
 *
 * 比例 + 分辨率查表得到像素 `size`；质量 6 档（`low` / `medium` / `high` / `xhigh` /
 * `max` / `auto`），与 Azure 文档的 GPT-Image-2.5 规格一致。
 *
 * `background`（透明）与 `outputFormat` 是联动的：Azure 文档要求透明背景必须 PNG，
 * 所以透明选项上挂了 `requires: { outputFormat: "png" }`，面板选中时会自动切格式。
 */
import { MB, imageCard } from "../../../card.js";

export const gptImage25 = imageCard({
  id: "gpt-image-2.5",
  title: "GPT Image 2.5",
  vendor: "openai",
  providerModelId: "gpt-image-2.5",
  // OpenAI 的文档站对爬虫返回 403，但这是图片 API 的权威页；人工访问正常。
  docs: "https://platform.openai.com/docs/api-reference/images",
  note: "比例 + 分辨率查表得到像素 size，quality 有 6 档",
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
