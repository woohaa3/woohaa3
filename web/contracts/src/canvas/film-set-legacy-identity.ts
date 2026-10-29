/**
 * 旧 `composite-asset` 片场身份（只读迁移输入）。
 *
 * 片场已迁到 group marker（change: 2026-10-28-migrate-film-set-to-groups）。这里的判断只用于
 * **读取/迁移旧数据**；任何新写入都在 `node-commands` 与 owner codec 处被拒绝。新代码不要
 * 依赖本模块，业务身份应从注册表解析。
 */
import { COMPOSITE_ASSET_NODE_TYPE, readCompositeAssetExtensionId } from "./domain/core/composite-asset-identity.js";

/** 片场业务扩展标识（规范判别值；仅旧 composite 读取使用）。 */
export const FILM_SET_EXTENSION_ID = "film-set" as const;

/** 是否为旧 `composite-asset` 片场节点。 */
export function isFilmSetNode(type: string | undefined, nodeData: unknown): boolean {
  return type === COMPOSITE_ASSET_NODE_TYPE
    && readCompositeAssetExtensionId(nodeData) === FILM_SET_EXTENSION_ID
    && (nodeData as { compositeAssetRole?: unknown }).compositeAssetRole === undefined;
}
