/**
 * 模型聚焦查看的共享数学与协议公共入口
 * （change: add-model-focus-viewing，任务 1.1 / 1.2；design D1–D4；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility R24 —— 拆分为
 *  类型、数学、画布投影、模型 bounds、相机与射线子模块）。
 *
 * 本模块无副作用、纯函数，Web 运行时、状态机与测试共用；与 Rust `model3d::focus` 共享同一
 * 常量与公式，用跨语言 fixture 对齐。它只描述**浏览器本地**的聚焦相机与命中数学，
 * 不进入 ServerCanvas / CanvasCommand / Y.Doc。
 *
 * 本文件为稳定 barrel；内部直接导入叶子模块。
 */

// 类型与常量。
export * from "./model-focus/types.js";

// 四元数小工具。
export * from "./model-focus/math.js";

// 画布坐标 ↔ 世界投影。
export * from "./model-focus/canvas-projection.js";

// 模型布局/world bounds/锚点/取景。
export * from "./model-focus/model-bounds.js";

// 相机 pose 与旋转。
export * from "./model-focus/focus-camera.js";

// 数值钳制。
export * from "./model-focus/clamp.js";

// 射线与 AABB 命中。
export * from "./model-focus/ray.js";

// 供其它模块复用的重导出，避免各处再 import model-transform。
export { dotVec3, lengthVec3 } from "./model-transform.js";
