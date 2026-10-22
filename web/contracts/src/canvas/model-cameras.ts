/**
 * 模型节点镜头子资源契约公共入口
 * （change: add-model-editor-gizmo-shot-capture，任务 1.1 / design D2；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility R18 —— 拆分为
 *  类型、画幅、codec 与 mutation 子模块）。
 *
 * 镜头是**模型节点的 canonical 子资源**（`nodeData.modelCameras`），不是独立画布节点、
 * 不创建 edge。派生 AABB focus、正交投影类型与 fit span 都是**版本化行为**，不逐镜头冗余
 * 持久化；session-only 状态绝不进入 canonical canvas / Y.Doc / nodeData。
 *
 * 本文件为稳定 barrel；内部直接导入叶子模块。
 */

// 类型与常量。
export * from "./model-cameras/types.js";

// 画幅解析与尺寸。
export * from "./model-cameras/aspect.js";

// 严格解码与读取。
export * from "./model-cameras/codec.js";

// mutation 与默认值/身份。
export * from "./model-cameras/mutation.js";
