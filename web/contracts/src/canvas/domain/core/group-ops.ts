/**
 * Group 结构操作公共入口
 * （change: add-canvas-node-grouping；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility R17 —— 拆分为
 *  几何、选区与 parenting 子模块）。
 *
 * 本文件为稳定 barrel；内部直接导入叶子模块。
 */

// 几何与坐标。
export * from "./group-geometry.js";

// 拓扑排序、选区闭包与选择规范化。
export * from "./group-selection.js";

// 成组/解组/reparent/refit 与 parentId 清洗。
export * from "./group-parenting.js";
