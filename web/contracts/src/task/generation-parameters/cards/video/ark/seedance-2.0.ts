/**
 * Seedance 2.0（火山方舟）。
 *
 * 2.0 家族时长上限 15 秒；图 + 视频参考。音频参考是 2.5 才有的能力，因此这里不 keep。
 */
import { MB, videoCard } from "../../../card.js";

export const seedance20 = videoCard({
  id: "seedance-2.0",
  title: "Seedance 2.0",
  vendor: "ark",
  providerModelId: "seedance-2",
  docs: "https://docs.volcengine.com/docs/ark/seedance-2-0?lang=zh",
  note: "2.0 家族：时长上限 15 秒，图 + 视频参考",
  keeps: [
    "prompt",
    "referencesImage",
    "referencesVideo",
    "generationMode",
    "durationSeconds",
    "aspectRatio",
    "resolution",
    "generateAudio",
    "outputFormat"
  ],
  narrow: {
    durationSeconds: { hiddenWhen: [{ field: "generationMode", equals: "edit_video" }] }
  },
  limits: {
    promptMaxChars: 1200,
    references: {
      image: { min: 0, max: 9, maxBytesPerItem: 10 * MB },
      video: { min: 0, max: 3, maxBytesPerItem: 20 * MB }
    },
    combined: [{ kinds: ["image", "video"], max: 9, label: "参考图 + 参考视频" }]
  }
});
