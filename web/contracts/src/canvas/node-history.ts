/**
 * 画布级节点生成版本历史契约公共入口
 * （change: add-canvas-node-generation-history，任务 1.1 / design D1–D3；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility R06 —— 拆分为
 *  类型、身份、cursor/查询、投影与 codec 子模块）。
 *
 * 无副作用纯 DTO、稳定 identity 与 opaque cursor codec，Frontend、Canvas Service 与测试
 * 共用同一份形状。历史是**画布权限域内的独立产品读模型**。
 *
 * 关键约束：
 * - 完整历史、缩略图与面板状态 **MUST NOT** 进入 Canvas Y.Doc / `ServerCanvas`；
 * - 列表只返回卡片所需的安全 metadata、受控预览引用与当前标记；
 * - 详情按 `entryId` 按需读取，由 Canvas Service 重新校验归属；
 * - `entryId` / `sourceIdentity` / `currentIdentity` 由稳定生成来源派生。
 *
 * 本文件为稳定 barrel；实现分别在 `node-history/` 子模块，内部直接导入叶子模块。
 */

// 类型与常量。
export * from "./node-history/types.js";

// 同类型节点合并请求/回执。
export * from "./node-history/merge.js";

// 稳定身份、内容身份与哈希。
export * from "./node-history/identity.js";

// opaque cursor 与查询归一化。
export * from "./node-history/query.js";

// 条目 → 安全列表项/完整详情投影。
export * from "./node-history/projection.js";

// 条目与 payload 的反序列化/校验。
export * from "./node-history/codec.js";

// 世界镜头设置保存/恢复与助手完成历史（T08）。
export * from "./node-history/world-camera.js";
