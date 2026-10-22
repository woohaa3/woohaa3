/**
 * 片场对象编辑的稳定请求 id（重试落到同一请求；新编辑生成新请求）。
 *
 * `filmSet.itemPatch` 命令本身由 `commandId` 去重；这里只保证用户重试时不重复。
 */
export function createFilmSetItemRequestId(): string {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `film-object-${random}`;
}
