import type { EditJournalDependencies } from "./edit-journal-model.js";

export function journalNow(deps: EditJournalDependencies): number {
  return deps.now?.() ?? Date.now();
}

export function generateJournalId(deps: EditJournalDependencies): string {
  if (deps.generateCommandId) return deps.generateCommandId();
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoRef?.randomUUID === "function") return cryptoRef.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
