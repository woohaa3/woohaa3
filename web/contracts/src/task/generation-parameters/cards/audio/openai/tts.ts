/**
 * TTS（OpenAI）。
 *
 * 官方 /v1/audio/speech：音色是闭集，输出格式六档，语速 0.25–4，输入 ≤ 4096 字符。
 * 这些数字写在卡片上，面板据此把音色与格式渲染成选择器，而不是让用户手输一个会被
 * 上游 400 的字符串。
 */
import { audioCard } from "../../../card.js";

/** tts-1 支持的系统音色（gpt-4o-mini-tts 的新音色不在这个模型的闭集里）。 */
const OPENAI_TTS_VOICES = [
  "alloy",
  "ash",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer"
] as const;

export const openaiTts = audioCard({
  id: "tts-1",
  title: "TTS（OpenAI）",
  vendor: "openai",
  providerModelId: "tts-1",
  docs: "https://platform.openai.com/docs/api-reference/audio/createSpeech",
  note: "音色 9 档、输出格式 6 种；语速 0.25–4，输入 ≤ 4096 字符",
  keeps: ["prompt", "voice", "outputFormat", "speed"],
  narrow: {
    voice: { default: "alloy", values: [...OPENAI_TTS_VOICES] },
    outputFormat: { default: "mp3", values: ["mp3", "opus", "aac", "flac", "wav", "pcm"] }
  },
  limits: {
    // 官方限制：input 最多 4096 个字符。
    promptMaxChars: 4096
  }
});
