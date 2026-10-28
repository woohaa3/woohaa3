/**
 * 片场稳定对象/部件身份编码
 * （自 `film-set-content.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R19）。
 *
 * `(itemId, partId)` 无碰撞编码；只依赖字符串，无其它 import。
 */

/**
 * 组合运行时身份：`(itemId, partId)` 的无碰撞编码（design D2）。
 *
 * 使用长度前缀而非裸分隔符，避免同名不同切分的 id 碰撞；items 重排不改变身份。
 * `partId` 为空字符串表示对象根。
 */
export function encodeFilmSetPartId(itemId: string, partId = ""): string {
  return `${itemId.length}:${itemId}${partId}`;
}

/** 解码 `encodeFilmSetPartId` 的输出；非法返回 null。 */
export function decodeFilmSetPartId(value: string): { itemId: string; partId: string } | null {
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const lengthText = value.slice(0, separator);
  const length = Number(lengthText);
  if (!Number.isInteger(length) || length < 0) return null;
  const rest = value.slice(separator + 1);
  if (rest.length < length) return null;
  return { itemId: rest.slice(0, length), partId: rest.slice(length) };
}
