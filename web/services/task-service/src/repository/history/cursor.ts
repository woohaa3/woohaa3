/**
 * Task 历史 repository：opaque cursor 编解码
 * （自 `history-repository.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R04）。
 */

/** cursor 编码排序位置 + 规范化查询指纹，不暴露数据库主键。 */
const CURSOR_VERSION = "v2";

export function encodeCursor(position: { createdAt: string; taskKey: string }, fingerprint = ""): string {
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, c: position.createdAt, k: position.taskKey, f: fingerprint })
  ).toString("base64url");
}

export function decodeCursor(
  cursor: string | undefined
): { createdAt: string; taskKey: string; fingerprint: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      v?: string;
      c?: string;
      k?: string;
      f?: string;
    };
    if (parsed.v !== CURSOR_VERSION || typeof parsed.c !== "string" || typeof parsed.k !== "string") return null;
    return { createdAt: parsed.c, taskKey: parsed.k, fingerprint: typeof parsed.f === "string" ? parsed.f : "" };
  } catch {
    return null;
  }
}
