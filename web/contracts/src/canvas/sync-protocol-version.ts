/**
 * 命令同步协议版本（change: 2026-10-09-improve-canvas-workflow，任务 1.3）。
 *
 * 放在主入口可达的纯模块里，使 `storage/core` 等只能依赖 `@woohaa3/contracts` 的边界
 * 也能引用同一常量；`canvas-yjs` 子入口从 `yjs/format.ts` 再导出，保持单一事实源。
 *
 * v3：复合资产身份、items-only 片场与独立镜头同次切换。
 * v4：拍摄镜头预览可作为**镜头参考**来源（预览 → 视频生成节点的持久化边与
 *     `shot_reference` 映射）。旧客户端会把这些边当作非法预览端点清理，因此必须在交换文档前
 *     由握手/命令解码明确拒绝并提示刷新，不映射、不静默丢弃。
 */
// v5: static shot image references; v4 normalizers cannot safely write these documents.
export const YJS_SYNC_PROTOCOL_VERSION = 5 as const;
export type YjsSyncProtocolVersion = typeof YJS_SYNC_PROTOCOL_VERSION;
