import type { BevyModelMediaPlane } from "./render-scene/wire-scene.js";
/**
 * `CanvasRenderScene` 映射层公共入口
 * （change: replace-godot-canvas-runtime-with-bevy，任务 1.1 / design D3/D6；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility R01 —— 拆分为
 *  wire 类型、节点几何、片场投影、节点读取与装配五个职责模块）。
 *
 * 本文件保留稳定公共入口：`buildCanvasRenderScene`、几何常量/函数、wire 类型、指纹与
 * `compositeAssetNodeBoxSize` 等既有导出不变；实现分别在 `render-scene/` 子模块。内部模块直接导入
 * 叶子模块，不反向 import 本 barrel。
 */

// wire 类型：节点/边/瞬时态与版本常量。
export * from "./render-scene/wire-model.js";
export * from "./render-scene/wire-scene.js";

// 节点/端口/抓手/连线/聚合几何：常量与纯函数。
export * from "./render-scene/node-geometry.js";

// 节点顶部操作横条（屏幕空间）纯几何（change: 2026-10-13-add-node-to-film-set-shortcut，任务 3.1）。
export * from "./render-scene/node-action-toolbar.js";

// 片场范围与媒体平面投影。
export * from "./render-scene/film-set-projection.js";

// 拍摄镜头预览卡片与归属线派生呈现
// （change: 2026-10-15-add-film-set-shooting-shot-previews，design D5/D8）。
export * from "./render-scene/shot-preview-projection.js";

// 复合资产范围形状几何（change: 2026-10-12-align-film-set-scope-with-isometric-grid）。
export * from "./render-scene/composite-asset-scope.js";

// 节点正文/纹理/placement 读取。
export * from "./render-scene/node-projection.js";

// 快照装配与呈现指纹。
export * from "./render-scene/scene-builder.js";

/** Stable decoded texture supplied to the native model renderer. */
export type BevyNativeMediaFrame = { plane: BevyModelMediaPlane; width: number; height: number; rgba: number[] };
