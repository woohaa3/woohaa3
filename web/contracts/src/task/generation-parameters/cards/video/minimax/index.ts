/**
 * MiniMax 视频卡片。
 *
 * 只有 H3 一个型号：`MiniMax-H3-Highspeed` / `-Lite` / `-Max` 是同一套接口的变体，
 * 差别只在分辨率档位与时长下限（家族表里按 id 前缀区分，卡片不各写一份）。
 */
import type { PresetCard } from "../../../card.js";
import { minimaxH3 } from "./h3.js";

export const MINIMAX_VIDEO_CARDS: readonly PresetCard[] = [minimaxH3];
