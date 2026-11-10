/**
 * Google Lyria 3（`lyria3` 与 `lyria3-clip`）。
 *
 * 这两个 id 在网关上有两条都能返回 200 的路由，但**内容完全不同**：
 * - `/v1/audio/music`：真正的音乐生成，实测 2:56 / 192kbps MP3；
 * - `/v1/audio/speech`：Gemini TTS，实测只回 2.5–4.8 秒朗读片段。
 *
 * 所以这张卡片的作用不只是剪参数：它也是「这个模型属于音乐」的声明，服务端据此把任务
 * 打到音乐路由。只断言任务成功无法发现路由走错——错路由同样 200，只是产出一段朗读。
 */
import { audioCard } from "../../../card.js";
import { MUSIC_KEEPS, MUSIC_NOTE } from "../music-shape.js";

export const lyria3 = audioCard({
  id: "lyria3",
  title: "Lyria 3",
  vendor: "google",
  providerModelId: "lyria3",
  docs: "https://cloud.google.com/vertex-ai/generative-ai/docs/music/generate-music",
  note: MUSIC_NOTE,
  keeps: [...MUSIC_KEEPS],
  limits: {
    promptMaxChars: 2000
  }
});

/** `lyria3-clip` 是同一模型的短片版本，参数形状一致。 */
export const lyria3Clip = audioCard({
  id: "lyria3-clip",
  title: "Lyria 3 Clip",
  vendor: "google",
  providerModelId: "lyria3-clip",
  docs: "https://cloud.google.com/vertex-ai/generative-ai/docs/music/generate-music",
  note: `${MUSIC_NOTE}（短片版本）`,
  keeps: [...MUSIC_KEEPS],
  limits: {
    promptMaxChars: 2000
  }
});
