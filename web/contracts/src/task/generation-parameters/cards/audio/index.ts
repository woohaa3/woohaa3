/**
 * 音频卡片总表。
 *
 * 分层与图片 / 视频一致：`<类型>/<厂商>/<模型>.ts` 声明单张卡片，厂商 `index.ts` 汇总，
 * 这里再汇总厂商。音频没有家族表：音色 / 格式 / 语速的值域由卡片本身给出。
 */
import type { PresetCard } from "../../card.js";
import { GENERIC_AUDIO_CARDS } from "./generic/index.js";
import { MINIMAX_AUDIO_CARDS } from "./minimax/index.js";
import { OPENAI_AUDIO_CARDS } from "./openai/index.js";

export const AUDIO_CARDS: readonly PresetCard[] = [
  ...OPENAI_AUDIO_CARDS,
  ...MINIMAX_AUDIO_CARDS,
  ...GENERIC_AUDIO_CARDS
];
