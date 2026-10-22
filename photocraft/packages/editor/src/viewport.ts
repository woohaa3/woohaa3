/**
 * 编辑器画布取景（纯数据）
 * （change: 2026-10-21-extract-photocraft-subproject，design D3）。
 *
 * 取景几何只描述图片内容在编辑器表面上的位置与缩放；Bevy 呈现、聚焦过渡与输入 owner
 * 归宿主。编辑器只消费这份快照并通过 `onChange` 交出新的取景。
 */
export type EditorViewport = { x: number; y: number; zoom: number };
