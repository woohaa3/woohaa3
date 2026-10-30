/**
 * MiniMax Speech 2.8 HD。
 *
 * 官方 /v1/t2a_v2 用 `voice_setting.voice_id` + `audio_setting.format` + `speed`；
 * 经 LiteLLM 网关后收成 /v1/audio/speech 的 voice / response_format / speed。
 *
 * 与 OpenAI 的两处差异写在卡片上：
 * 1. **语速是 0.5–2**（不是 OpenAI 的 0.25–4），卡片收窄后滑块不会选到上游拒绝的值；
 * 2. **输出格式没有 aac**，且官方还有 pcmu 变体——那些不在服务端的 Content-Type 映射里，
 *    这里不声明，避免存成错误的媒体类型。
 *
 * 音色列出常用系统音色（中文 / 英文 / 日文 / 粤语）并带人读名称；完整列表见
 * 官方「系统音色列表」与 Get Voice API。默认取官方示例里的青涩青年音色。
 */
import { audioCard } from "../../../card.js";

/**
 * 常用系统音色：值与名称都来自官方系统音色列表。
 *
 * 不抄全部 300+ 条：面板是选择器而不是音色字典，完整列表会随账号与版本变化，
 * 由 Get Voice API 提供。这里放各语种最常用的一批，保证开箱可用。
 */
const MINIMAX_SYSTEM_VOICES = [
  { value: "male-qn-qingse", label: "青涩青年音色（中文）" },
  { value: "male-qn-jingying", label: "精英青年音色（中文）" },
  { value: "male-qn-badao", label: "霸道青年音色（中文）" },
  { value: "male-qn-daxuesheng", label: "青年大学生音色（中文）" },
  { value: "female-shaonv", label: "少女音色（中文）" },
  { value: "female-yujie", label: "御姐音色（中文）" },
  { value: "female-chengshu", label: "成熟女性音色（中文）" },
  { value: "female-tianmei", label: "甜美女性音色（中文）" },
  { value: "Chinese (Mandarin)_Lyrical_Voice", label: "抒情男声（中文）" },
  { value: "Chinese (Mandarin)_HK_Flight_Attendant", label: "港普空姐（中文）" },
  { value: "English_expressive_narrator", label: "Expressive Narrator（英文）" },
  { value: "English_radiant_girl", label: "Radiant Girl（英文）" },
  { value: "English_Graceful_Lady", label: "Graceful Lady（英文）" },
  { value: "English_Trustworthy_Man", label: "Trustworthy Man（英文）" },
  { value: "English_Aussie_Bloke", label: "Aussie Bloke（英文）" },
  { value: "English_Whispering_girl", label: "Whispering Girl（英文）" },
  { value: "English_Diligent_Man", label: "Diligent Man（英文）" },
  { value: "English_Gentle-voiced_man", label: "Gentle-voiced Man（英文）" },
  { value: "Japanese_IntellectualSenior", label: "Intellectual Senior（日文）" },
  { value: "Japanese_DecisivePrincess", label: "Decisive Princess（日文）" },
  { value: "Cantonese_GentleLady", label: "温柔女声（粤语）" },
  { value: "Cantonese_PlayfulMan", label: "活泼男声（粤语）" }
] as const;

export const minimaxSpeech = audioCard({
  id: "minimax-speech-2.8-hd",
  title: "MiniMax Speech 2.8 HD",
  vendor: "minimax",
  providerModelId: "minimax-speech-2.8-hd",
  docs: "https://platform.minimax.cn/docs/api-reference/speech-t2a-http",
  note: "常用系统音色（中 / 英 / 日 / 粤）；语速 0.5–2；输出格式不含 aac",
  keeps: ["prompt", "voice", "outputFormat", "speed"],
  narrow: {
    voice: { default: "male-qn-qingse", values: [...MINIMAX_SYSTEM_VOICES] },
    outputFormat: { default: "mp3", values: ["mp3", "pcm", "flac", "wav", "opus"] },
    speed: { default: 1, minimum: 0.5, maximum: 2 }
  }
});
