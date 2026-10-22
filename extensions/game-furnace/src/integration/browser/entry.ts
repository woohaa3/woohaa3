/**
 * 游戏炼丹炉 extension 前端入口（构建期扫描约定入口）
 * （change: 2026-10-10-add-game-furnace-extension，任务 2.4/2.5；按 integration 新架构重实现）。
 *
 * `extensions/game-furnace/src/frontend/index.ts` 是构建期可信扫描入口：扫描器只读取
 * `descriptor`。`descriptor.plugin()` 是无副作用工厂；宿主按**服务端 `game-furnace` 实际 active
 * 状态**（server-active reconciler）在 Canvas page scope 装配本插件，因此扩展停用/不可用时
 * 「创建游戏炼丹炉」菜单项随 owner 释放而不出现（任务 2.5）。
 *
 * 与后端 identity 对齐：前后端共用稳定 `game-furnace` extensionId，不另建可独立开关的入口。
 *
 * 除 descriptor 外，本入口只转出包内前端公共面（node template id + plugin 工厂），供 Frontend/
 * Showcase 与测试按公开路径消费，不直接 import 包内私有相对路径。
 */
import type { ExtensionFrontendDescriptor } from "@woohaa3/frontend/extension-api";
import { GAME_FURNACE_FRONTEND_METADATA } from "./metadata.js";
import { gameFurnaceExtension } from "./plugin.js";

export { gameFurnaceExtension, GAME_FURNACE_NODE_TEMPLATE_ID, GAME_FURNACE_FOCUS_WORKSPACE_ID, GAME_FURNACE_NODE_DROP_ID, GAME_FURNACE_FOCUS_KIND } from "./plugin.js";
export { GameFurnaceWorkspace, type GameFurnaceWorkspaceProps } from "./workspace.js";
export { GAME_FURNACE_FRONTEND_METADATA } from "./metadata.js";

/**
 * 构建期扫描读取的入口描述。`plugin()` 无副作用；服务端 active 装配（`server-active`）。
 * 站点扩展：`game-furnace` 的菜单贡献随其服务端实际状态失效/恢复。
 */
export const descriptor: ExtensionFrontendDescriptor = {
  ...GAME_FURNACE_FRONTEND_METADATA,
  plugin: () => gameFurnaceExtension()
};
