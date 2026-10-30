/**
 * 通用音频卡片：复刻服务端按类型写死的语音形状。
 *
 * 服务端 /v1/audio/speech 只认音色、输出格式与语速；这里把它落到语义键
 * （outputFormat 由 Provider 翻成 response_format）。音色保持自由文本——上游的音色 id
 * 不是一套跨厂商枚举，写死一份只会很快过期。
 */
import { audioCard } from "../../../card.js";

export const genericAudio = audioCard({
  id: "audio-generic",
  title: "音频通用（托管服务端）",
  vendor: "generic",
  providerModelId: "audio-generic",
  docs: "https://docs.litellm.ai/docs/providers/openai",
  note: "服务端按类型写死的音色 / 格式 / 语速，没有约束声明",
  keeps: ["prompt", "voice", "outputFormat", "speed"]
});
