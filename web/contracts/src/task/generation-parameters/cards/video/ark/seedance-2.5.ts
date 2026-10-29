/**
 * Seedance 2.5（火山方舟）。
 *
 * 图 / 视频 / 音频三类参考都能用；编辑模式隐藏时长与比例。值域（4–30 秒、三档分辨率）
 * 来自 `families/video` 的 `seedance-2.5` 家族，这里只声明「接哪些键」与边界。
 */
import { MB, videoCard } from "../../../card.js";

export const seedance25 = videoCard({
  id: "seedance-2.5",
  title: "Seedance 2.5",
  vendor: "ark",
  providerModelId: "seedance-2.5",
  docs: "https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh",
  note: "图 / 视频 / 音频三类参考；编辑模式隐藏时长与比例",
  keeps: [
    "prompt",
    "referencesImage",
    "referencesVideo",
    "referencesAudio",
    "generationMode",
    "durationSeconds",
    "aspectRatio",
    "resolution",
    "generateAudio",
    "outputFormat",
    "seed",
    "cameraFixed",
    "returnLastFrame"
  ],
  narrow: {
    durationSeconds: { hiddenWhen: [{ field: "generationMode", equals: "edit_video" }] }
  },
  limits: {
    promptMaxChars: 2000,
    references: {
      image: { min: 0, max: 30, maxBytesPerItem: 10 * MB },
      video: { min: 0, max: 10, maxBytesPerItem: 50 * MB },
      audio: { min: 0, max: 10, maxBytesPerItem: 15 * MB }
    },
    combined: [{ kinds: ["image", "video"], max: 30, label: "参考图 + 参考视频" }]
  }
});
