import { ManagedNodeLifecycleRegistry, type CanvasContentRuntime } from "@woohaa3/contracts";

/** Merge trusted declarations without choosing a business extension by position. */
export function mergeCanvasContentRuntimes(entries: readonly { extensionId: string; runtime: CanvasContentRuntime }[]): CanvasContentRuntime | undefined {
  if (!entries.length) return undefined;
  const result: CanvasContentRuntime = { managedLifecycles: [], managedMigrations: [] };
  const lifecycle = new ManagedNodeLifecycleRegistry(), migrations = new Set<string>();
  for (const { extensionId, runtime } of entries) {
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
    for (const capability of ["frames", "conversion", "mcp", "recording"] as const) {
      if (!runtime[capability]) continue;
      if (result[capability]) throw Error(`canvas-content-registration-conflict: ${capability}`);
      Object.assign(result, { [capability]: runtime[capability] });
    }
  }
  result.managedLifecycles = lifecycle.implementations();
  return result;
}
