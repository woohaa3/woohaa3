/**
 * game-furnace extension 纯前端 metadata
 * （change: 2026-10-12-build-and-load-extensions-independently，任务 1.2 / design D4）。
 *
 * 只导出 JSON 可序列化数据；identity 复用 `../shared/types.js` 叶子常量。
 * `index.ts` 的 descriptor 复用本 metadata。
 */
import type { ExtensionFrontendMetadata } from "@woohaa3/contracts";
import { EXTENSION_SDK_ABI_VERSION } from "@woohaa3/contracts";
import { GAME_FURNACE_LABEL, GAME_FURNACE_PLUGIN_ID } from "../../state/shared/types.js";

export const GAME_FURNACE_FRONTEND_METADATA: ExtensionFrontendMetadata = {
  extensionId: GAME_FURNACE_PLUGIN_ID,
  version: "0.1.0",
  label: GAME_FURNACE_LABEL,
  description: "游戏炼丹炉：收集画布素材并经本站文本模型生成可试玩 HTML 游戏。",
  icon: "game",
  activation: "server-active",
  configScope: "site",
  required: false,
  sdkAbi: EXTENSION_SDK_ABI_VERSION
};
