/**
 * MiniMax H3。
 *
 * 官方 `POST /v2/video_generation`：一个 `content` 数组承载多模态（text / image_url /
 * video_url / audio_url），模式由 **role** 决定——
 *
 * - 纯 text：文生视频；
 * - `first_frame` / `last_frame` 图：图生视频（首帧 / 尾帧 / 首尾帧）；
 * - `reference_image` / `reference_video` / `reference_audio`：参考生视频。
 *
 * 两条容易踩的规则：
 * 1. **图生视频与参考生视频互斥**：出现任一 reference role 时不能同时出现 first/last frame；
 * 2. **图生视频的比例恒为 adaptive**：传别的值不报错但会被忽略，比例由输入图决定。
 *
 * 值域（4–15 秒整数、768P / 2K、6 种画幅 + adaptive）来自 `families/video` 的
 * `minimax-h3` 家族；这里只声明「接哪些键」与边界。
 */
import { MB, videoCard } from "../../../card.js";

export const minimaxH3 = videoCard({
  id: "minimax-h3",
  title: "MiniMax H3",
  vendor: "minimax",
  providerModelId: "minimax-h3",
  docs: "https://platform.minimax.io/docs/api-reference/video-generation-v2-create",
  note: "文生 / 图生 / 参考生视频三模式；图生与参考互斥",
  keeps: [
    "prompt",
    "referencesImage",
    "referencesVideo",
    "referencesAudio",
    "generationMode",
    "durationSeconds",
    "aspectRatio",
    "resolution"
  ],
  limits: {
    // 官方：prompt ≤ 7000 字符。
    promptMaxChars: 7000,
    references: {
      // 首帧 / 尾帧各 ≤ 1，参考图 ≤ 9；混合输入总计 ≤ 12。
      image: { min: 0, max: 9, maxBytesPerItem: 30 * MB },
      video: { min: 0, max: 3, maxBytesPerItem: 50 * MB },
      audio: { min: 0, max: 3, maxBytesPerItem: 15 * MB }
    },
    total: { max: 12 },
    // 首尾帧与参考素材互斥，所以单类上限不能简单相加：这里按官方「混合输入 ≤ 12」收起。
    combined: [{ kinds: ["image", "video", "audio"], max: 12, label: "参考素材合计" }]
  }
});
