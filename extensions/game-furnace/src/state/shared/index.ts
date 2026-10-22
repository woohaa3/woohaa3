/**
 * 游戏炼丹炉 extension 共享纯内容契约（barrel）
 * （change: 2026-10-10-add-game-furnace-extension，任务 1.1–1.5 / design D2/D4/D5/D7）。
 *
 * 这是**唯一**一份 identity、codec、纯 reducer / inverse、内容 hash、素材规划与引用提取。
 * 浏览器、Canvas 权威服务与后端共同消费同一份定义；它不 import 任何宿主 store、Provider、
 * 数据库、DOM 或 Node API，因此可作为 `shared` 入口被两端安全加载。
 *
 * 说明（按 integration 新架构重实现）：原实现把本内容挂在被移除的「容器插件」体系上，并使用
 * `ContainerContentDefinition`。目标分支已彻底移除该体系，因此这里改为**独立的扩展内容定义**
 * （`GameFurnaceContentDefinition`）；呈现意图（纯模型 / focus-only / copy-immediate / 工作区）
 * 保留为声明，由宿主按新架构的通用节点与聚焦工作区能力实现，主引擎/Canvas/Task 仍不出现
 * `if (pluginId === 'game-furnace')` 业务分支（任务 1.7）。
 *
 * 为满足业务源码 ≤500 行门禁，拆为叶子模块；本文件只做稳定再导出（公共 API 不变）。
 */
import type { Woohaa3CanvasJsonObject } from "@woohaa3/contracts";
import { GAME_FURNACE_LABEL, GAME_FURNACE_PLUGIN_ID, GAME_FURNACE_SCHEMA_VERSION, type GameFurnaceState } from "./types.js";
import { createGameFurnaceState, duplicateGameFurnace, invertGameFurnace, reduceGameFurnace, validateGameFurnaceState } from "./reducer.js";
import { gameFurnaceReferences } from "./content.js";

// 常量、类型与预算。
export * from "./types.js";
// 素材规范化与可用性。
export * from "./resources.js";
// 内容身份（hash）、references 与校验。
export * from "./content.js";
// 操作与纯 reducer / inverse / duplicate。
export * from "./reducer.js";

/**
 * 扩展内容公共定义。
 *
 * 原实现在此返回 `ContainerContentDefinition`（容器 registry 用 `pluginId`/`reduce`/`invert`/
 * `references`/`presentation` 注册）。目标分支移除容器体系后，宿主不再有该注册点，因此这里只
 * 保留**内容身份的纯函数**与**呈现意图声明**，供前端工作区、后端与将来的通用呈现能力消费。
 */
export type GameFurnaceContentDefinition = {
  pluginId: string;
  schemaVersion: number;
  label: string;
  create: () => Woohaa3CanvasJsonObject;
  validate: (state: Woohaa3CanvasJsonObject) => void;
  reduce: (state: Woohaa3CanvasJsonObject, operations: readonly Woohaa3CanvasJsonObject[]) => Woohaa3CanvasJsonObject;
  invert: (stateBefore: Woohaa3CanvasJsonObject, operations: readonly Woohaa3CanvasJsonObject[]) => Woohaa3CanvasJsonObject[];
  references: (state: Woohaa3CanvasJsonObject) => readonly string[];
  duplicate: (state: Woohaa3CanvasJsonObject, newId: () => string) => Woohaa3CanvasJsonObject;
  /** 通用呈现意图（design D2/D3）；具体由宿主通用能力实现，不由主引擎分支业务插件。 */
  presentation: {
    layout: "model";
    inputMode: "focus-only";
    dropPolicy: "copy-immediate";
    workspace: boolean;
  };
};

export const gameFurnaceContent: GameFurnaceContentDefinition = {
  pluginId: GAME_FURNACE_PLUGIN_ID,
  schemaVersion: GAME_FURNACE_SCHEMA_VERSION,
  label: GAME_FURNACE_LABEL,
  create: () => createGameFurnaceState("pending"),
  validate: validateGameFurnaceState,
  reduce: reduceGameFurnace,
  invert: invertGameFurnace,
  references: (state) => gameFurnaceReferences(state as unknown as GameFurnaceState),
  duplicate: duplicateGameFurnace,
  presentation: { layout: "model", inputMode: "focus-only", dropPolicy: "copy-immediate", workspace: true }
};
