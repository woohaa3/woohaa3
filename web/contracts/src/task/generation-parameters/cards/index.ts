/**
 * 全部模型卡片：按类型汇总。
 *
 * 目录结构即分类：`cards/<image|video>/<vendor>/<model>.ts`。找某个模型的参数，
 * 直接按路径打开那个文件；加一个新模型，就在对应厂商目录里加一个文件。
 */
import type { PresetCard } from "../card.js";
import { IMAGE_CARDS } from "./image/index.js";
import { VIDEO_CARDS } from "./video/index.js";

export { IMAGE_CARDS } from "./image/index.js";
export { VIDEO_CARDS } from "./video/index.js";

export const BUILTIN_PRESET_CARDS: readonly PresetCard[] = [...IMAGE_CARDS, ...VIDEO_CARDS];
