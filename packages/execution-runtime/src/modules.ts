import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Executor } from "./protocol.js";

export type ExecutorModuleRegistration = {
  registrationId: string;
  modules: readonly { id: string; module: string; export: string }[];
};

/** Atomic, version-bound registrations. A failed import never publishes a partial executor set. */
export class ExecutorModules {
  private readonly registrations = new Map<string, { identity: string; executors: Executor[] }>();
  private pending = Promise.resolve();
  constructor(private readonly stateDir: string) {}
  list(): Executor[] { return [...this.registrations.values()].flatMap(item => item.executors); }
  register(input: ExecutorModuleRegistration): Promise<string[]> {
    const operation = this.pending.then(async () => {
      if (!input.registrationId || !Array.isArray(input.modules) || !input.modules.length) throw new Error("Invalid executor registration");
      const identity = JSON.stringify(input.modules);
      const existing = this.registrations.get(input.registrationId);
      if (existing) {
        if (existing.identity !== identity) throw new Error("Executor registration identity conflict");
        return existing.executors.map(item => item.id);
      }
      const executors: Executor[] = [];
      const ids = new Set<string>();
      for (const entry of input.modules) {
        if (!entry.id || ids.has(entry.id)) throw new Error("Duplicate executor id");
        ids.add(entry.id);
        const url = pathToFileURL(entry.module);
        url.searchParams.set("revision", createHash("sha256").update(await readFile(entry.module)).digest("hex"));
        const module = await import(url.href) as Record<string, unknown>;
        const factory = module[entry.export];
        if (typeof factory !== "function") throw new Error(`Missing executor export: ${entry.export}`);
        const executor = await factory({ stateDir: this.stateDir }) as Executor;
        if (!executor || executor.id !== entry.id || !["agent", "generation", "any"].includes(executor.kind) || typeof executor.run !== "function") throw new Error(`Invalid executor module: ${entry.id}`);
        executors.push({ id: `${input.registrationId}/${entry.id}`, kind: executor.kind, run: executor.run.bind(executor) });
      }
      this.registrations.set(input.registrationId, { identity, executors });
      return executors.map(item => item.id);
    });
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }
  unregister(registrationId: string): Promise<string[]> {
    const operation = this.pending.then(() => {
      const ids = this.registrations.get(registrationId)?.executors.map(item => item.id) ?? [];
      this.registrations.delete(registrationId);
      return ids;
    });
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
