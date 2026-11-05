import { ContentContributionRegistry, ManagedNodeLifecycleRegistry, type CanvasContentRuntime } from "@woohaa3/contracts";

/** Merge trusted declarations without choosing a business extension by position. */
export function mergeCanvasContentRuntimes(entries: readonly { extensionId: string; runtime: CanvasContentRuntime }[]): CanvasContentRuntime | undefined {
  if (!entries.length) return undefined;
  const result: CanvasContentRuntime = { managedLifecycles: [], managedMigrations: [] };
  const content = new ContentContributionRegistry();
  const lifecycle = new ManagedNodeLifecycleRegistry(), migrations = new Set<string>();
  for (const { extensionId, runtime } of entries) {
    if (runtime.contributions !== undefined) {
      for (const contribution of runtime.contributions) {
        if (contribution.extensionId !== extensionId) throw Error("content-registration-owner-mismatch");
        content.register(contribution);
      }
      result.contributions = content.implementations();
    }
    for (const adapter of runtime.managedLifecycles ?? []) {
      if (adapter.extensionId !== extensionId) throw Error("managed-lifecycle-registration-owner-mismatch");
      lifecycle.register(adapter);
    }
    for (const migration of runtime.managedMigrations ?? []) {
      if (migration.extensionId !== extensionId || migration.schemaVersion !== 1 || typeof migration.migrate !== "function") throw Error("managed-migration-registration-owner-mismatch");
      if (migrations.has(migration.extensionId)) throw Error("managed-migration-registration-conflict");
      migrations.add(migration.extensionId);
      result.managedMigrations = [...result.managedMigrations!, migration];
    }
  }
  result.managedLifecycles = lifecycle.implementations();
  return result;
}
