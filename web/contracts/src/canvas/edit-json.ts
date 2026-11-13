/** Compare persisted JSON values without depending on normalization object identity or key order. */
export function equalEditJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  return ak.length === bk.length && ak.every(key => Object.prototype.hasOwnProperty.call(b, key) && equalEditJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
