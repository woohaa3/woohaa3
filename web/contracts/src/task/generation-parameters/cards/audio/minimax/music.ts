/**
 * MiniMax Music 2.6。
 *
 * 官方是纯音乐生成（`minimax/music-2.6`，256 kbps）。经 LiteLLM 网关走
 * `/v1/audio/music`，请求体只有 `model` + `prompt`。实测网关返回的是对象存储直链
 * （`data[0].url`），由服务端抓取后落成稳定媒体，客户端只拿 storageKey。
 *
 * **不要把它当 TTS 用**：发到 `/v1/audio/speech` 会稳定 500（网关把它映射到
 * `custom_llm_provider=tencent`，该 provider 没接这个端点）。
 */
import { audioCard } from "../../../card.js";
import { MUSIC_KEEPS, MUSIC_NOTE } from "../music-shape.js";

export const minimaxMusic = audioCard({
  id: "minimax-music-2.6",
  title: "MiniMax Music 2.6",
  vendor: "minimax",
  providerModelId: "minimax-music-2.6",
  docs: "https://platform.minimax.io/docs/api-reference/music-generation",
  note: MUSIC_NOTE,
  keeps: [...MUSIC_KEEPS],
  limits: {
    // 音乐生成是长耗时任务：实测一首约 3 分钟。服务端只把它当展示值，不参与判定。
    promptMaxChars: 2000
  }
});
