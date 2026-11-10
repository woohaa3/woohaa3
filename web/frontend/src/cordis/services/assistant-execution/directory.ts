import type { AgentCatalogResponse, AgentConnectionView } from "@woohaa3/contracts";
import type { AgentConversationService } from "../../contract/agent-conversation.js";
import type { CurrentUserService } from "../current-user.js";
import type { CanvasSession } from "../canvas-session.js";

type DirectoryService = Pick<AgentConversationService, "listConnections" | "catalog"> & Partial<Pick<AgentConversationService, "invalidateDirectory">>;
export type DirectorySnapshot = {
  sourceStates: Record<string, { status: "loading" | "ready" | "failed"; error?: string }>;
  connections: AgentConnectionView[];
  catalogs: Record<string, AgentCatalogResponse>;
  ready: boolean;
  loadingMessage: string;
  error: string;
};
const empty = (): DirectorySnapshot => ({ sourceStates: {}, connections: [], catalogs: {}, ready: false, loadingMessage: "正在读取助手连接…", error: "" });
const MAX_AGE_MS = 60_000;

/** Shared API reads: reuse successful results and in-flight requests across every assistant UI. */
export function cacheAgentDirectoryReads(service: DirectoryService, dataScopeId: () => string | null) {
  const clearers: Array<() => void> = [];
  function cached<T extends { ok: boolean }>(read: (adapterId?: string) => Promise<T>) {
    const entries = new Map<string, { promise: Promise<T>; expires: number }>();
    clearers.push(() => entries.clear());
    const keyFor = (adapterId?: string) => JSON.stringify([dataScopeId(), adapterId ?? null]);
    const peek = (adapterId?: string) => {
      if (!dataScopeId()) return undefined;
      const entry = entries.get(keyFor(adapterId));
      return entry && Date.now() < entry.expires ? entry.promise : undefined;
    };
    const load = (adapterId?: string): Promise<T> => {
      const existing = peek(adapterId);
      if (existing) return existing;
      const namespace = dataScopeId();
      if (!namespace) return read(adapterId);
      const key = keyFor(adapterId);
      const entry = { promise: Promise.resolve().then(() => read(adapterId)), expires: Infinity };
      entries.set(key, entry);
      void entry.promise.then(result => {
        if (entries.get(key) !== entry) return;
        if (result.ok) entry.expires = Date.now() + MAX_AGE_MS;
        else entries.delete(key);
      }, () => { if (entries.get(key) === entry) entries.delete(key); });
      return entry.promise;
    };
    return { load, peek };
  }
  const connections = cached(service.listConnections);
  const catalogs = cached(service.catalog);
  const invalidateDirectory = () => {
    for (const clear of clearers) clear();
    for (const store of directories.get(invalidateDirectory)?.values() ?? []) store.invalidate();
  };
  return {
    listConnections: (adapterId?: string) => {
      const all = adapterId ? connections.peek() : undefined;
      return all ? all.then(result => result.ok ? { ok: true as const, value: result.value.filter(c => c.adapterId === adapterId) } : result) : connections.load(adapterId);
    },
    catalog: catalogs.load,
    invalidateDirectory
  };
}

/** Page-service and data-space scoped; no credentials or cross-user persistent cache. */
export class AgentDirectoryStore {
  private snapshot = empty();
  private listeners = new Set<() => void>();
  private pending: Promise<void> | null = null;
  private generation = 0;
  private loadedAt = -Infinity;
  private activeReads = 0;
  private readWaiters: Array<() => void> = [];
  private async readCatalog(adapterId: string) {
    if (this.activeReads < 4) this.activeReads++;
    else await new Promise<void>(resolve => this.readWaiters.push(resolve));
    try { return await this.service.catalog(adapterId); }
    finally {
      const next = this.readWaiters.shift();
      if (next) next(); else this.activeReads--;
    }
  }

  constructor(private service: DirectoryService) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(patch: Partial<DirectorySnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  invalidate = () => {
    this.generation++;
    this.pending = null;
    this.loadedAt = -Infinity;
    this.publish(empty());
  };

  retry = async (adapterId: string): Promise<void> => {
    const generation = this.generation;
    this.publish({ sourceStates: { ...this.snapshot.sourceStates, [adapterId]: { status: "loading" } } });
    try {
      const result = await this.readCatalog(adapterId);
      if (generation !== this.generation) return;
      const sourceStates: DirectorySnapshot["sourceStates"] = { ...this.snapshot.sourceStates, [adapterId]: result.ok ? { status: "ready" } : { status: "failed", error: result.error } };
      const error = Object.entries(sourceStates).flatMap(([id, state]) => state.status === "failed" ? [`${this.snapshot.connections.filter(c => c.adapterId === id).map(c => c.name).join(" / ")}：${state.error}`] : []).join("；");
      this.publish({ sourceStates, error,
        ...(result.ok ? { catalogs: { ...this.snapshot.catalogs, [adapterId]: result.value } } : {}) });
    } catch (error) {
      if (generation === this.generation) this.publish({ sourceStates: { ...this.snapshot.sourceStates, [adapterId]: { status: "failed", error: String(error) } } });
    }
  };

  load = (force = false): Promise<void> => {
    if (!force && this.pending) return this.pending;
    if (!force && this.snapshot.ready && Date.now() - this.loadedAt < MAX_AGE_MS) return Promise.resolve();
    // 显式刷新/配置变化会丢弃可能已移除的连接，但保留上一次模型目录直到新目录成功返回：
    // 刷新耗时或失败时不应让已经可用的模型列表瞬间变空。
    const previousCatalogs = this.snapshot.catalogs;
    if (force) this.service.invalidateDirectory?.();
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    if (force) this.snapshot = { ...empty(), catalogs: previousCatalogs };
    this.publish({ loadingMessage: "正在读取助手连接…", error: "" });
    this.pending = Promise.resolve().then(async () => {
      try {
        const result = await this.service.listConnections();
        if (!current()) return;
        if (!result.ok) throw new Error(result.error);
        const waiting = new Map([...new Set(result.value.filter(c => !c.models?.length).map(c => c.adapterId))].map(id => [
          id, [...new Set(result.value.filter(c => c.adapterId === id).map(c => c.name))].join(" / ")
        ]));
        const names = new Map(waiting);
        const total = waiting.size;
        const progress = () => {
          if (current() && waiting.size) this.publish({ loadingMessage: `正在读取模型与能力（${total - waiting.size}/${total}）：${[...waiting.values()].join("、")}…` });
        };
        progress();
        this.publish({ connections: result.value, ready: true, sourceStates: Object.fromEntries(result.value.map(c => [c.adapterId, { status: waiting.has(c.adapterId) ? "loading" : "ready" }])) });
        const ids = [...waiting.keys()];
        const entries: Array<readonly [string, Awaited<ReturnType<DirectoryService["catalog"]>>]> = [];
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
          while (cursor < ids.length && current()) {
            const id = ids[cursor++]!;
            let catalog: Awaited<ReturnType<DirectoryService["catalog"]>>;
            try { catalog = await this.readCatalog(id); }
            catch (error) { catalog = { ok: false, code: "catalog-error", error: error instanceof Error ? error.message : "目录读取失败" }; }
            entries.push([id, catalog]);
            if (current()) this.publish({
              sourceStates: { ...this.snapshot.sourceStates, [id]: catalog.ok ? { status: "ready" } : { status: "failed", error: catalog.error } },
              ...(catalog.ok ? { catalogs: { ...this.snapshot.catalogs, [id]: catalog.value } } : {})
            });
            waiting.delete(id); progress();
          }
        }));
        if (!current()) return;
        const failures = entries.flatMap(([id, catalog]) => catalog.ok ? [] : [`${names.get(id)}：${catalog.error}`]);
        // Keep a just-observed failure visible until explicit retry or normal cache expiry.
        this.loadedAt = Date.now();
        // 单次读取失败（进程冷启动、回合进行中）不应清空已经可用的目录：保留上一次成功结果，
        // 只把原因放进 error，下一次刷新仍会尝试真实目录。
        const catalogs = { ...previousCatalogs };
        for (const [id, catalog] of entries) {
          if (!catalog.ok) continue;

          catalogs[id] = catalog.value;
        }
        this.publish({
          connections: result.value,
          catalogs,
          ready: true, error: failures.join("；")
        });
      } catch (error) {
        if (current()) this.publish({ error: error instanceof Error ? error.message : "助手目录读取失败" });
      } finally {
        if (current()) {
          this.pending = null;
          this.publish({ loadingMessage: "" });
        }
      }
    });
    return this.pending;
  };
}

const directories = new WeakMap<object, Map<string, AgentDirectoryStore>>();
export function agentDirectory(service: DirectoryService, dataScopeId: string): AgentDirectoryStore {
  const owner = service.invalidateDirectory ?? service;
  let spaces = directories.get(owner);
  if (!spaces) { spaces = new Map(); directories.set(owner, spaces); }
  let store = spaces.get(dataScopeId);
  if (!store) { store = new AgentDirectoryStore(service); spaces.set(dataScopeId, store); }
  return store;
}

/** Warm once per data space after the canvas is ready, without delaying canvas startup. */
export function preloadAgentDirectory(
  service: DirectoryService,
  user: Pick<CurrentUserService, "getSnapshot" | "subscribe">,
  session: Pick<CanvasSession, "getStatus" | "subscribe">
): () => void {
  let warmedSpace: string | undefined;
  const warm = () => {
    const namespace = user.getSnapshot()?.dataScopeId;
    if (!namespace) { warmedSpace = undefined; return; }
    if (session.getStatus().phase !== "ready" || warmedSpace === namespace) return;
    warmedSpace = namespace;
    void agentDirectory(service, namespace).load();
  };
  const unsubscribeUser = user.subscribe(warm);
  const unsubscribeSession = session.subscribe(warm);
  warm();
  return () => { unsubscribeUser(); unsubscribeSession(); };
}
