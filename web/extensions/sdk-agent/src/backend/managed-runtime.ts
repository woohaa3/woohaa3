import type { AgentSdkTransport } from "./adapters/agent-sdk-adapter.js";

type Lease = { entry: string; release: () => void | Promise<void> };
type Resolver = { resolve(id: string): Promise<Lease> };

/** Resolve at turn time so configuration changes never reuse a stale executable. */
export function createLeasedTransport(
  manager: Resolver,
  id: string,
  create: (entry: string) => Promise<AgentSdkTransport>
): AgentSdkTransport {
  const transports = new Map<string, Promise<AgentSdkTransport>>();
  const contexts = new Set<string>();
  return {
    async run(input) {
      const context = id === "dsh" ? input.resourceKey : undefined;
      if (context && contexts.has(context)) return { ok: false, code: "capability-unsupported", message: "前轮尚未排空" };
      if (context) contexts.add(context);
      let lease: Lease | undefined;
      try {
        lease = await manager.resolve(id);
        let transport = transports.get(lease.entry);
        if (!transport) {
          transport = create(lease.entry);
          transports.set(lease.entry, transport);
          const entry = lease.entry;
          void transport.catch(() => { if (transports.get(entry) === transport) transports.delete(entry); });
        }
        return await (await transport).run(input);
      } finally {
        try { await lease?.release(); }
        finally { if (context) contexts.delete(context); }
      }
    }
  };
}
