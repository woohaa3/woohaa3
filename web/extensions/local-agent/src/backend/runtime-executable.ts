type Lease = { entry: string; release(): void };
type Manager = { inspect(id: string): Promise<{ status: string; entry?: string }>; resolve(id: string): Promise<Lease> };

/** Discovery only inspects; execution owns a lease until its child process exits. */
export function createRuntimeExecutableResolver(options: { local(id: string): string | null; getManager(): Manager | undefined }) {
  return {
    executableFor: async (id: string): Promise<string | null> => {
      const local = options.local(id);
      if (local) return local;
      const manager = id === "codex-appserver" ? options.getManager() : undefined;
      if (!manager) return null;
      const state = await manager.inspect("codex");
      return state.status === "ready" ? state.entry ?? null : null;
    },
    acquire: async (id: string): Promise<Lease | null> => {
      const local = options.local(id);
      if (local) return { entry: local, release: () => {} };
      const manager = id === "codex-appserver" ? options.getManager() : undefined;
      if (!manager) return null;
      return manager.resolve("codex");
    }
  };
}
