import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Executor } from "./protocol.js";

export type ExecutorModuleRegistration = {
  registrationId: string;
  modules: readonly { id: string; module: string; export: string }[];
};

/**
 * Atomic, version-bound registrations. A failed import never publishes a partial executor set.
 *
 * `detach` 保留模块与在途回合（宿主优雅关闭），由 daemon 在回合全部终态后调用
 * `unregisterIdleDetached` 异步注销；没有在途回合时立即可注销。
 */
export class ExecutorModules {
  private readonly registrations = new Map<string, { identity: string; executors: Executor[] }>();
  private readonly detached = new Set<string>();
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
        this.detached.delete(input.registrationId);
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
      this.detached.delete(input.registrationId);
      return executors.map(item => item.id);
    });
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }
  unregister(registrationId: string): Promise<string[]> {
    const operation = this.pending.then(() => {
      const ids = this.registrations.get(registrationId)?.executors.map(item => item.id) ?? [];
      this.registrations.delete(registrationId);
      this.detached.delete(registrationId);
      return ids;
    });
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }
  /** 标记为 detach：不取消在途回合，等终态后由 `unregisterIdleDetached` 注销。 */
  detach(registrationId: string): string[] {
    const entry = this.registrations.get(registrationId);
    if (!entry) return [];
    this.detached.add(registrationId);
    return entry.executors.map(item => item.id);
  }
  /** 注销已 detach 且没有这些执行器身份的活跃回合的注册；返回被注销的 registrationId。 */
  unregisterIdleDetached(activeExecutorIds: ReadonlySet<string>): string[] {
    const removed: string[] = [];
    for (const registrationId of [...this.detached]) {
      const entry = this.registrations.get(registrationId);
      if (!entry) { this.detached.delete(registrationId); continue; }
      if (entry.executors.some(item => activeExecutorIds.has(item.id))) continue;
      this.registrations.delete(registrationId);
      this.detached.delete(registrationId);
      removed.push(registrationId);
    }
    return removed;
  }
  detachedIds(): string[] { return [...this.detached]; }
}
