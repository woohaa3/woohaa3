/**
 * 火山方舟（Ark）视频卡片。
 *
 * 三条 Seedance：2.5 能力最全（含音频参考与编辑模式），2.0 收窄到 15 秒，1.0 只接受首帧图。
 * 新增同家族版本时，在这里登记一行即可——值域由家族表按 id 匹配，不必再抄一遍。
 */
import type { PresetCard } from "../../../card.js";
import { seedance25 } from "./seedance-2.5.js";
import { seedance20 } from "./seedance-2.0.js";
import { seedance10 } from "./seedance-1.0.js";

export const ARK_VIDEO_CARDS: readonly PresetCard[] = [seedance25, seedance20, seedance10];
