/**
 * 视频卡片总表。
 *
 * 分层：`<类型>/<厂商>/<模型>.ts` 声明单张卡片，厂商 `index.ts` 汇总，这里再汇总厂商。
 * 新增一个厂商 = 新目录 + 一行 import；新增一个模型 = 厂商目录内加文件 + 一行登记。
 */
import type { PresetCard } from "../../card.js";
import { ARK_VIDEO_CARDS } from "./ark/index.js";
import { GOOGLE_VIDEO_CARDS } from "./google/index.js";
import { MINIMAX_VIDEO_CARDS } from "./minimax/index.js";
import { GENERIC_VIDEO_CARDS } from "./generic/index.js";

export const VIDEO_CARDS: readonly PresetCard[] = [
  ...ARK_VIDEO_CARDS,
  ...GOOGLE_VIDEO_CARDS,
  ...MINIMAX_VIDEO_CARDS,
  ...GENERIC_VIDEO_CARDS
];
