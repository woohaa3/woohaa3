import type { ExtensionDocument, ExtensionDocumentStore, ExtensionDocumentValue } from "@woohaa3/contracts";
export function memoryDocuments(): ExtensionDocumentStore {
  const entries = new Map<string, ExtensionDocument>(); let schema = 0;
  return {
    owner: () => "creature-video-assets",
    async get<T extends ExtensionDocumentValue>(key: string) { const entry = entries.get(key); return entry ? { found: true, document: structuredClone(entry) as ExtensionDocument<T> } : { found: false }; },
    async batch(operations) {
      for (const operation of operations) if (operation.expectedRevision !== undefined && (entries.get(operation.key)?.revision ?? null) !== operation.expectedRevision) return { ok: false, code: "revision-conflict", key: operation.key, currentRevision: entries.get(operation.key)?.revision ?? null };
      const revisions: Record<string, number | null> = {};
      for (const operation of operations) { if (operation.op === "delete") { entries.delete(operation.key); revisions[operation.key] = null; } else { const revision = (entries.get(operation.key)?.revision ?? 0) + 1; entries.set(operation.key, { key: operation.key, value: structuredClone(operation.value), revision, updatedAt: new Date().toISOString() }); revisions[operation.key] = revision; } }
      return { ok: true, revisions };
    },
    async scan(prefix) { return { entries: [...entries.values()].filter(entry => entry.key.startsWith(prefix)).map(entry => structuredClone(entry)), nextCursor: null }; },
    async schemaVersion() { return schema; }, async setSchemaVersion(value) { schema = value; }
  };
}
