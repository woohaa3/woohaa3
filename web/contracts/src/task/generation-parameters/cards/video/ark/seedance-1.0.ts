/**
 * Seedance 1.0（火山方舟）。
 *
 * 只接受首帧图，没有音频与视频参考；时长 2–12 秒。约束里的 `max: 2` 会直接落到
 * 目录的 `bindings[].maxItems`——面板与提交契约用同一个数字。
 */
import { MB, videoCard } from "../../../card.js";

export const seedance10 = videoCard({
  id: "seedance-1.0",
  title: "Seedance 1.0",
  vendor: "ark",
  providerModelId: "seedance-1",
  docs: "https://docs.volcengine.com/docs/ark/seedance-1-0-pro-pro-fast?lang=zh",
  note: "1.0 家族：只接受首帧图，时长 2–12 秒",
  keeps: ["prompt", "referencesImage", "durationSeconds", "aspectRatio", "resolution"],
  limits: {
    promptMaxChars: 800,
    references: { image: { min: 0, max: 2, maxBytesPerItem: 10 * MB } }
  }
});
