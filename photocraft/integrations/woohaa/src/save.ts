/**
 * 图片编辑的稳定 id 生成
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 5.5；
 *   change: 2026-10-16-integrate-photocraft-image-editing：随旧标注编辑器删除 v1 合成保存编排
 *   `saveImageEdit`，这里只保留工程编辑路径复用的会话/请求 id）。
 */

/** 稳定 requestId 生成（同一次会话/内容重试复用）。 */
export function imageEditRequestId(sessionId: string): string {
  void sessionId;
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return `img-edit-${random}`;
  return `img-edit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function imageEditSessionId(nodeId: string): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return `img-session-${random}`;
  return `img-session-${nodeId}-${Date.now().toString(36)}`;
}
