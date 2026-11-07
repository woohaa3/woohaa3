/**
 * Agnes Video 2.5（Agnes AI）。
 *
 * 上游按 OpenAI Videos 形状接受 `seconds` / `size`，另用 `aspect_ratio` 声明画幅。
 * 比例 / 分辨率 / 时长都是必填（现场错误：`aspectRatio is required`、
 * `resolution is required`、`duration maximum value is 12 seconds ...`），值域由
 * `families/video` 的 `agnes-video-2.5` 家族统一给出，这里只声明保留哪些语义键。
 */
import { videoCard } from "../../../card.js";

export const agnesVideo25 = videoCard({
  id: "agnes-video-2.5",
  title: "Agnes Video 2.5",
  vendor: "agnes",
  providerModelId: "agnes-video-2.5",
  docs: "https://wiki.agnes-ai.com/en/docs/agnes-video-25",
  note: "比例 / 分辨率 / 时长为必填；720p、1080p、2k，5–12 秒",
  keeps: [
    "prompt",
    "referencesImage",
    "referencesVideo",
    "durationSeconds",
    "aspectRatio",
    "resolution"
  ]
});
