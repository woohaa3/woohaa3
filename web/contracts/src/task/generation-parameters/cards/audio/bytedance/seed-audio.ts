/**
 * 字节 Seed-Audio 1.0（`seed-audio-1.0`）。
 *
 * 走 `/v1/audio/music`，返回内联的 `b64_json`（实测是 WAV）。和 lyria3 一样，
 * 它发到 `/v1/audio/speech` 会 500——那是 TTS 端点，不接受音乐模型。
 */
import { audioCard } from "../../../card.js";
import { MUSIC_KEEPS, MUSIC_NOTE } from "../music-shape.js";

export const seedAudio = audioCard({
  id: "seed-audio-1.0",
  title: "Seed-Audio 1.0",
  vendor: "bytedance",
  providerModelId: "seed-audio-1.0",
  docs: "https://www.volcengine.com/docs/82379/1520757",
  note: MUSIC_NOTE,
  keeps: [...MUSIC_KEEPS],
  limits: {
    promptMaxChars: 2000
  }
});
