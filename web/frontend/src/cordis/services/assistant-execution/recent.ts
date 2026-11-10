/** Public identities only. Recording is called exclusively after authoritative acceptance. */
const memory = new Map<string, string[]>();
const listeners = new Set<() => void>();
const key = (space: string, purpose: string) => `woohaa3.generation-recent.v1:${JSON.stringify([space, purpose])}`;
export const generationIdentity = (connectionId: string, model: string) => JSON.stringify([connectionId, model]);
export function readRecentGeneration(space: string, purpose: string): string[] {
  const id = key(space, purpose);
  if (memory.has(id)) return memory.get(id)!;
  try { const data = JSON.parse(globalThis.localStorage?.getItem(id) ?? "[]"); if (Array.isArray(data)) memory.set(id, data.filter((v): v is string => typeof v === "string").slice(0, 12)); } catch { /* Session fallback. */ }
  if (!memory.has(id)) memory.set(id, []);
  return memory.get(id)!;
}
export function recordAcceptedGeneration(space: string, purpose: string, identity: string): void {
  const values = [identity, ...readRecentGeneration(space, purpose).filter(v => v !== identity)].slice(0, 12);
  const id = key(space, purpose); memory.set(id, values);
  try { globalThis.localStorage?.setItem(id, JSON.stringify(values)); } catch { /* Session fallback. */ }
  listeners.forEach(listener => listener());
}
export function subscribeRecentGeneration(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
