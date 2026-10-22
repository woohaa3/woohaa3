/**
 * 导演场展示名常量
 * （change: 2026-10-10-add-game-furnace-extension，design D1）。
 *
 * 独立的最小无依赖模块：`domain/normalization.ts`（画布规范化）与 `agent-node-descriptors.ts`
 * （节点描述符）共用同一展示名事实源，**不**经由会触发 `render-scene.ts` 的导入链，避免
 * `normalization → agent-node-descriptors → render-scene → domain/index → normalization` 的
 * 模块初始化循环。
 *
 * 保留 canonical 节点类型 `animation3d` 与全部技术字段，这不是节点类型迁移。
 */

/** 导演场（`animation3d`）当前系统默认标题。 */
export const DIRECTOR_STUDIO_DEFAULT_TITLE = "导演场";

/** 已废弃的历史默认标题；仅用于识别「系统创建且未被用户改写」的旧标题。 */
export const LEGACY_ANIMATION_DEFAULT_TITLE = "3D 片场";
