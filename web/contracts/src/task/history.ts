/**
 * Task execution history DTO 公共入口
 * （change: split-web-runtime-services，任务 1.3；
 *   change: 2026-10-06-improve-task-history-experience，任务 1.1/1.2/1.4；
 *   change: 2026-10-09-refactor-large-source-files-and-remove-compatibility R20 —— 拆分为
 *   类型、守卫、查询与脱敏子模块）。
 *
 * 全局历史页与 Canvas 补偿都只读这一套 read model。它**只暴露安全字段**：默认排除完整
 * prompt、provider 原始 input/output、媒体 bytes、签名 URL、Authorization、堆栈与凭据。
 *
 * 本文件为稳定 barrel；内部直接导入叶子模块。
 */

// 类型与常量。
export * from "./history/types.js";

// 类型守卫与状态谓词。
export * from "./history/guards.js";

// 生命周期耗时计算（纯函数；监控 facade 与页面共用同一套定义）。
export * from "./history/timing.js";

// 查询解析与指纹。
export * from "./history/query.js";

// 脱敏白名单与预算。
export * from "./history/sanitization.js";

// 媒体就绪派生（节点输出、预览、下载与活动项共用）。
export * from "./history/media-readiness.js";
