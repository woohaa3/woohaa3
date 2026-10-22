/**
 * 游戏炼丹炉炉体几何（Scene IR V2 / `woohaa-model-js-v2`）
 * （change: 2026-10-10-add-game-furnace-extension，任务 3.5 / design D3）。
 *
 * 炉体是 extension **自有**的三维几何，由既有宿主纯模型渲染管线执行与呈现（宿主不出现任何
 * 炼丹炉专属分支）。几何至少包含：三足、炉腹、炉沿/开口、双耳与可识别的青铜/炭材料，
 * 不能以 emoji / 二维图标 / 普通卡片或单个基础球体代替（design D3）。
 *
 * 说明（按 integration 新架构重实现）：原实现把几何托管给被移除的容器渲染体系；目标分支改由
 * 通用复合资产节点（`composite-asset` + `extensionId="game-furnace"`）承载 `modelScript`，由既有
 * `model-scene` 管线执行成 Scene IR 后经纯模型通道呈现。本模块为纯内容，不 import 宿主 store、
 * Provider、DOM 或 Node API。
 */
import { MODEL_SCRIPT_V2_VERSION, COMPOSITE_ASSET_NODE_TYPE, createModel3DNodeData, model3DNodeDataFields } from "@woohaa3/contracts";
import type { CanvasNodeData } from "@woohaa3/contracts";

/** 复合资产节点 canonical 类型（与宿主契约同源；业务由 nodeData.extensionId 判别）。 */
export const GAME_FURNACE_NODE_TYPE = COMPOSITE_ASSET_NODE_TYPE;

/** 炼丹炉默认展示名（节点可被用户重命名覆盖）。 */
export const GAME_FURNACE_DEFAULT_TITLE = "游戏炼丹炉";

/**
 * 炉体几何脚本（确定性，无随机/时间/外部依赖）。
 *
 * 结构（局部坐标，整体约 1.4 宽 × 1.9 高，由宿主纯模型通道等比适配到节点范围框）：
 * - `leg-a/b/c`：三足（圆柱，外撇）；
 * - `belly`：炉腹（扁球，青铜材质）；
 * - `rim`：炉沿（扁平圆柱）；
 * - `mouth`：炉口（炭黑内凹）；
 * - `ear-a/b`：双耳（横向圆柱）；
 * - `grate`：炉底箅口（深色薄圆柱）。
 */
export const GAME_FURNACE_GEOMETRY_SCRIPT = `// 游戏炼丹炉炉体（extension 自有几何；确定性、可复现）。
scene.material({ id: "bronze", baseColor: "#9a6a34", roughness: 0.45, metallic: 0.65 });
scene.material({ id: "gold", baseColor: "#c9a24a", roughness: 0.35, metallic: 0.8 });
scene.material({ id: "charcoal", baseColor: "#2b2622", roughness: 0.9, metallic: 0.05 });
scene.material({ id: "ember", baseColor: "#ff6a2a", emissive: "#ff5a1e", emissiveStrength: 2.2, roughness: 0.6 });

scene.group({ id: "game-furnace", position: [0, 0, 0] });

// --- 三足（外撇圆柱）---
scene.cylinder({ id: "leg-a", parent: "game-furnace", radius: 0.1, height: 0.55, position: [-0.42, -0.62, 0.24], rotation: [12, 0, -14], material: "bronze" });
scene.cylinder({ id: "leg-b", parent: "game-furnace", radius: 0.1, height: 0.55, position: [0.42, -0.62, 0.24], rotation: [12, 0, 14], material: "bronze" });
scene.cylinder({ id: "leg-c", parent: "game-furnace", radius: 0.1, height: 0.55, position: [0, -0.62, -0.48], rotation: [-14, 0, 0], material: "bronze" });

// --- 炉腹（扁球）---
scene.sphere({ id: "belly", parent: "game-furnace", radius: 0.58, position: [0, 0.04, 0], scale: [1, 0.92, 1], material: "bronze" });

// --- 炉底箅口（深色薄圆柱）---
scene.cylinder({ id: "grate", parent: "game-furnace", radius: 0.3, height: 0.06, position: [0, -0.5, 0], material: "charcoal" });

// --- 炉沿与炉口 ---
scene.cylinder({ id: "rim", parent: "game-furnace", radius: 0.52, height: 0.14, position: [0, 0.6, 0], material: "gold" });
scene.cylinder({ id: "mouth", parent: "game-furnace", radius: 0.42, height: 0.08, position: [0, 0.66, 0], material: "charcoal" });
// 炉内火光（低强度自发光，增强可识别性）
scene.cylinder({ id: "ember-core", parent: "game-furnace", radius: 0.3, height: 0.04, position: [0, 0.6, 0], material: "ember" });

// --- 双耳（横向圆柱）---
scene.cylinder({ id: "ear-a", parent: "game-furnace", radius: 0.07, height: 0.34, position: [-0.6, 0.56, 0], rotation: [0, 0, 90], material: "gold" });
scene.cylinder({ id: "ear-b", parent: "game-furnace", radius: 0.07, height: 0.34, position: [0.6, 0.56, 0], rotation: [0, 0, 90], material: "gold" });
`;

/** 炉体几何的必要部件 ID（测试与可读性用；渲染不依赖此列表）。 */
export const GAME_FURNACE_PART_IDS: readonly string[] = [
  "game-furnace",
  "leg-a",
  "leg-b",
  "leg-c",
  "belly",
  "grate",
  "rim",
  "mouth",
  "ember-core",
  "ear-a",
  "ear-b"
];

/**
 * 新建炼丹炉节点的默认 `nodeData`：通用纯模型扩展节点 + 炉体几何。
 *
 * 返回的是**通用**完整自包含 3D 定义（源码、语言、版本、内容标识与摆放），不写任何游戏专属
 * 宿主字段；项目内容（素材/需求/生成/构建）由后端 content 定义另行承载（见 shared）。
 */
export function createGameFurnaceNodeData(title: string = GAME_FURNACE_DEFAULT_TITLE): CanvasNodeData {
  return { extensionId: "game-furnace", scenePlacement: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 }, ...model3DNodeDataFields(createModel3DNodeData({
    title,
    model: { modelScript: GAME_FURNACE_GEOMETRY_SCRIPT, modelScriptVersion: MODEL_SCRIPT_V2_VERSION }
  })) } as CanvasNodeData;
}

/** 仅接受显式业务身份；旧节点由隔离离线迁移识别。 */
export function isGameFurnaceNodeData(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  return record.extensionId === "game-furnace";
}
