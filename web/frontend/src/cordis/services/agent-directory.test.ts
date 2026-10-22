import { afterEach, expect, it, vi } from "vitest";
import type { AgentCatalogResponse, AgentConnectionView } from "@woohaa3/contracts";
import { agentDirectory, cacheAgentDirectoryReads, preloadAgentDirectory } from "./agent-directory.js";

const connection = { connectionId: "one", adapterId: "adapter", name: "助手", models: [] } as unknown as AgentConnectionView;
const catalog = { models: [], capabilities: { targets: ["canvas-group"], tools: true } } as unknown as AgentCatalogResponse;
function fixture() {
  let namespace: string | null = "space";
  const raw = {
    listConnections: vi.fn(async () => ({ ok: true as const, value: [connection] })),
    catalog: vi.fn(async () => ({ ok: true as const, value: catalog }))
  };
  const service = cacheAgentDirectoryReads(raw, () => namespace);
  return { raw, service, setSpace: (value: string | null) => { namespace = value; } };
}
afterEach(() => vi.restoreAllMocks());

it("prewarming shares connections and capabilities with every service consumer and deduplicates in-flight reads", async () => {
  const { raw, service } = fixture();
  const store = agentDirectory(service, "space");
  const warm = store.load();
  expect(store.load()).toBe(warm);
  const first = service.listConnections();
  expect(service.listConnections()).toBe(first);
  await warm;
  await service.catalog("adapter");
  await service.listConnections("adapter");
  await service.listConnections("other");
  expect(raw.listConnections).toHaveBeenCalledTimes(1);
  expect(raw.catalog).toHaveBeenCalledTimes(1);
  expect(await service.listConnections("other")).toEqual({ ok: true, value: [] });
  expect(store.getSnapshot().ready).toBe(true);
  await store.load();
  expect(store.getSnapshot().loadingMessage).toBe("");
});

it("expired data stays usable while the directory refreshes in the background", async () => {
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { raw, service } = fixture();
  const store = agentDirectory(service, "space");
  await store.load();
  now += 60_001;
  const refresh = store.load();
  expect(store.getSnapshot().ready).toBe(true);
  expect(store.getSnapshot().connections).toEqual([connection]);
  await refresh;
  expect(raw.listConnections).toHaveBeenCalledTimes(2);
  expect(raw.catalog).toHaveBeenCalledTimes(2);
});

it("configuration refresh supersedes pending reads and cannot be overwritten by late responses", async () => {
  const { raw, service } = fixture();
  let resolveOld!: (value: { ok: true; value: AgentConnectionView[] }) => void;
  raw.listConnections.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  const store = agentDirectory(service, "space");
  const old = store.load();
  await vi.waitFor(() => expect(raw.listConnections).toHaveBeenCalledTimes(1));
  await store.load(true);
  resolveOld({ ok: true, value: [{ ...connection, name: "旧连接" }] });
  await old;
  expect(store.getSnapshot().connections[0]?.name).toBe("助手");
  expect((await service.listConnections()).ok).toBe(true);
  expect(raw.listConnections).toHaveBeenCalledTimes(2);
  service.invalidateDirectory();
  expect(store.getSnapshot().ready).toBe(false);
  await store.load();
  expect(raw.listConnections).toHaveBeenCalledTimes(3);
});

it("isolates data spaces and never caches a failed read or an unresolved identity", async () => {
  let namespace: string | null = "one";
  const listConnections = vi.fn()
    .mockResolvedValueOnce({ ok: false, error: "暂时不可用", code: "unavailable" })
    .mockResolvedValue({ ok: true, value: [connection] });
  const service = cacheAgentDirectoryReads({ listConnections, catalog: async () => ({ ok: true, value: catalog }) }, () => namespace);
  expect((await service.listConnections()).ok).toBe(false);
  await service.listConnections();
  await service.listConnections();
  expect(listConnections).toHaveBeenCalledTimes(2);
  namespace = "two";
  await service.listConnections();
  expect(listConnections).toHaveBeenCalledTimes(3);
  expect(agentDirectory(service, "one")).not.toBe(agentDirectory(service, "two"));
  namespace = null;
  await service.listConnections();
  await service.listConnections();
  expect(listConnections).toHaveBeenCalledTimes(5);
});

it("waits for a ready canvas and known identity, warms once, and unsubscribes on page disposal", async () => {
  const { raw, service } = fixture();
  let namespace: string | null = null;
  let phase = "loading";
  const userListeners = new Set<() => void>();
  const sessionListeners = new Set<() => void>();
  const subscribe = (listeners: Set<() => void>) => (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const stop = preloadAgentDirectory(service, {
    subscribe: subscribe(userListeners), getSnapshot: () => namespace ? { dataScopeId: namespace } as never : null
  }, {
    subscribe: listener => subscribe(sessionListeners)(() => listener({ phase } as never)),
    getStatus: () => ({ phase }) as never
  });
  namespace = "space";
  userListeners.forEach(listener => listener());
  expect(raw.listConnections).not.toHaveBeenCalled();
  phase = "ready";
  sessionListeners.forEach(listener => listener());
  await agentDirectory(service, "space").load();
  sessionListeners.forEach(listener => listener());
  expect(raw.listConnections).toHaveBeenCalledTimes(1);
  stop();
  expect(userListeners.size + sessionListeners.size).toBe(0);
});
