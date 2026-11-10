/**
 * 音频卡片总表。
 *
 * 分层与图片 / 视频一致：`<类型>/<厂商>/<模型>.ts` 声明单张卡片，厂商 `index.ts` 汇总，
 * 这里再汇总厂商。音频没有家族表：音色 / 格式 / 语速的值域由卡片本身给出。
 *
 * **语音合成与音乐生成是两类**：语音卡片保留 voice / outputFormat / speed，音乐卡片
 * 只保留 prompt / lyrics。两者 modelType 都是 audio，差别由卡片剪枝表达。
 */
import type { PresetCard } from "../../card.js";
import { BYTEDANCE_AUDIO_CARDS } from "./bytedance/index.js";
import { GENERIC_AUDIO_CARDS } from "./generic/index.js";
import { GOOGLE_AUDIO_CARDS } from "./google/index.js";
import { MINIMAX_AUDIO_CARDS } from "./minimax/index.js";
import { OPENAI_AUDIO_CARDS } from "./openai/index.js";

export const AUDIO_CARDS: readonly PresetCard[] = [
  ...OPENAI_AUDIO_CARDS,
  ...MINIMAX_AUDIO_CARDS,
  ...GOOGLE_AUDIO_CARDS,
  ...BYTEDANCE_AUDIO_CARDS,
  ...GENERIC_AUDIO_CARDS
];
