/**
 * 复合资产节点共同类别与业务身份
 * （change: 2026-10-11-extract-film-set-extension，D1/D11/D12）。
 *
 * 「复合资产节点」管理由原始素材组成的复合资产，当前以模型/场景直接呈现在画布，无顶部卡片、
 * 标题/状态面板、端口或内嵌预览容器。片场（film-set）与游戏炼丹炉（game-furnace）是首批业务，
 * 共享**唯一** canonical type `composite-asset`，以 nodeData.extensionId 严格判别业务。
 *
 * 权威规则：
 * - 不再有 `animation3d` / `extension3d` 生产别名；旧值只出现在隔离离线 reader/拒绝测试/备份；
 * - 公共类别判断只看 type；业务操作必须 `(type, extensionId)` 完整判别；
 * - 缺失/未知/混合身份不被猜测（未知业务保留数据与引用、诊断、禁止业务写入）；
 * - 呈现分类（无卡片、无端口、纯模型投影）不等于 authoring 权限。
 */
export const COMPOSITE_ASSET_NODE_TYPE = "composite-asset" as const;

/** 片场业务扩展标识（规范判别值）。 */
export const FILM_SET_EXTENSION_ID = "film-set" as const;
/** 游戏炼丹炉业务扩展标识（规范判别值）。 */
export const GAME_FURNACE_EXTENSION_ID = "game-furnace" as const;
/** 生物视频资产制作扩展。 */
export const CREATURE_VIDEO_ASSETS_EXTENSION_ID = "creature-video-assets" as const;

/** 受信任的业务 extensionId 集合（用于严格 nodeData 校验与未知业务识别）。 */
export const COMPOSITE_ASSET_EXTENSION_IDS = [FILM_SET_EXTENSION_ID, GAME_FURNACE_EXTENSION_ID, CREATURE_VIDEO_ASSETS_EXTENSION_ID] as const;

export type CompositeAssetExtensionId = (typeof COMPOSITE_ASSET_EXTENSION_IDS)[number];

/** 是否复合资产节点类别（不看业务）。 */
export function isCompositeAssetNodeType(type: string | undefined): boolean {
  return type === COMPOSITE_ASSET_NODE_TYPE;
}

/**
 * 读取并校验受信任的复合资产业务标识；缺失/未知返回 `null`（调用方诊断，不猜测）。
 */
export function readCompositeAssetExtensionId(nodeData: unknown): CompositeAssetExtensionId | null {
  if (typeof nodeData !== "object" || nodeData === null) return null;
  const id = (nodeData as { extensionId?: unknown }).extensionId;
  return typeof id === "string" && (COMPOSITE_ASSET_EXTENSION_IDS as readonly string[]).includes(id)
    ? (id as CompositeAssetExtensionId)
    : null;
}

/** 是否为片场业务节点（`composite-asset` + `extensionId="film-set"`）。 */
export function isFilmSetNode(type: string | undefined, nodeData: unknown): boolean {
  return isCompositeAssetNodeType(type) && readCompositeAssetExtensionId(nodeData) === FILM_SET_EXTENSION_ID
    && (nodeData as { compositeAssetRole?: unknown }).compositeAssetRole === undefined;
}

/** 是否为游戏炼丹炉业务节点（`composite-asset` + `extensionId="game-furnace"`）。 */
export function isGameFurnaceNode(type: string | undefined, nodeData: unknown): boolean {
  return isCompositeAssetNodeType(type) && readCompositeAssetExtensionId(nodeData) === GAME_FURNACE_EXTENSION_ID;
}
