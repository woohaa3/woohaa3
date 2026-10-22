/**
 * 「显式启用同步」的待同步集合。
 *
 * 为什么需要它：登录远端只代表远端可用，本地画布默认不上传。用户在某张画布上点「同步远端」
 * 后，这张画布进入待同步集合——此时远端目录还**没有**它（首次推送尚未完成），但同步上游
 * 必须已经为它返回链路，否则第一次推送永远发不出去。
 *
 * 为什么按会话维度隔离（serverUrl + subject）：同一份文档存储可能先后服务多个账号/部署。
 * 登出后集合**不删除**（同一账号重连后仍要继续完成首次同步）；换账号或换地址则不得串用，
 * 否则新账号会把另一个账号的「启用决定」当成自己的。
 *
 * 入口模式与 `session-store.ts` 一致：宿主注入 owner-scoped 文档存储时持久化，否则退化为
 * 进程内存——不伪造一个「看起来持久」的载体。文档里只有画布 id，没有任何凭据。
 */
import type { ExtensionDocumentStore, ExtensionDocumentValue } from "@woohaa3/contracts";

/** 文档键：单个文档承载所有会话维度，避免按账号散落未知数量的键。 */
const PENDING_KEY = "canvas-sync/pending";

/** 读取/写入的边界：异常输入不得把文档撑到读不动，也不该让内存集合无限增长。 */
const MAX_SCOPES = 32;
const MAX_PENDING_PER_SCOPE = 500;

/** 会话维度：远端地址 + 已登录主体。两者任一不同就不算同一个待同步集合。 */
export type RemoteSyncScope = { serverUrl: string; subject: string };

/**
 * 待同步集合（用户显式启用、但远端目录尚未确认的画布）。
 *
 * 写失败必须抛出：那是真的没存下来，调用方不能假装「已启用」。读失败一律当作空集合
 * （安全方向：宁可让人再点一次，也不拿读不懂的记录去同步）。
 */
export type RemoteSyncPendingStore = {
  has(scope: RemoteSyncScope, canvasId: string): Promise<boolean>;
  add(scope: RemoteSyncScope, canvasId: string): Promise<void>;
  remove(scope: RemoteSyncScope, canvasId: string): Promise<void>;
  /** 批量移除（远端目录已确认存在时用）：一次写入，返回真正移除的条数。 */
  removeMany(scope: RemoteSyncScope, canvasIds: Iterable<string>): Promise<number>;
};

type ScopeEntry = { serverUrl: string; subject: string; canvasIds: Set<string> };

/** 会话维度的键：JSON 数组形态避免 `|` / 换行这类分隔符与 URL、主体串味。 */
function scopeKeyOf(scope: RemoteSyncScope): string {
  return JSON.stringify([scope.serverUrl, scope.subject]);
}

/** 内存实现：缺省与测试用；进程退出即失效。 */
export function createMemorySyncPendingStore(): RemoteSyncPendingStore {
  return createPendingStore(null);
}

/** 宿主文档存储实现（owner-scoped）；写入是整份文档的原子覆盖。 */
export function createDocumentSyncPendingStore(documents: ExtensionDocumentStore): RemoteSyncPendingStore {
  return createPendingStore(documents);
}

function createPendingStore(documents: ExtensionDocumentStore | null): RemoteSyncPendingStore {
  /**
   * 内存镜像。
   *
   * 文档存储是它的持久化副本：读取一次即常驻，写入时整份覆盖。这样 `resolve()` 的热路径
   * （每次重新解析所有 room）不必每张画布都读一次存储。
   */
  const scopes = new Map<string, ScopeEntry>();
  /** 首次读取只做一次；并发调用共享同一个 promise。 */
  let loading: Promise<void> | null = null;
  /** 写入串行化：两个画布同时启用时不能互相覆盖整份文档。 */
  let queue: Promise<unknown> = Promise.resolve();

  const load = (): Promise<void> => {
    if (documents === null) return Promise.resolve();
    loading ??= (async () => {
      // 读失败（存储不可用、数据形状不符）当作空集合：这与会话存储同一口径。
      const record = await documents.get(PENDING_KEY).catch(() => null);
      if (record === null || !record.found) return;
      for (const entry of parsePersisted(record.document.value)) {
        scopes.set(scopeKeyOf(entry), entry);
      }
    })();
    return loading;
  };

  const persist = async (next: Map<string, ScopeEntry>): Promise<void> => {
    if (documents === null) return;
    const value: ExtensionDocumentValue = {
      version: 1,
      scopes: [...next.values()].map((entry) => ({
        serverUrl: entry.serverUrl,
        subject: entry.subject,
        canvasIds: [...entry.canvasIds]
      }))
    };
    const result = await documents.batch([{ op: "set", key: PENDING_KEY, value }]);
    if (!result.ok) {
      throw new Error(result.code === "revision-conflict" ? "待同步集合写入冲突" : result.message);
    }
  };

  /**
   * 在副本上修改、落盘成功后才切换内存镜像。
   *
   * 顺序刻意是「先写后切」：写失败时内存里也不该留下「已启用」的假象，否则界面会显示成功、
   * 而重启后画布又回到本地。返回真正变化的条数（0 表示无需写盘）。
   */
  const transact = (change: (next: Map<string, ScopeEntry>) => number): Promise<number> => {
    const run = async (): Promise<number> => {
      await load();
      const next = cloneScopes(scopes);
      const changed = change(next);
      if (changed === 0) return 0;
      await persist(next);
      scopes.clear();
      for (const [key, entry] of next) scopes.set(key, entry);
      return changed;
    };
    // 前一次失败不该挡住后一次（每次调用各自拿到自己的错误）。
    const pending = queue.then(run, run);
    queue = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  };

  const entryOf = (next: Map<string, ScopeEntry>, scope: RemoteSyncScope): ScopeEntry => {
    const key = scopeKeyOf(scope);
    const existing = next.get(key);
    if (existing !== undefined) return existing;
    // 边界：会话维度过多时淘汰最早的一个（Map 保持插入顺序）。
    if (next.size >= MAX_SCOPES) {
      const oldest = next.keys().next();
      if (!oldest.done) next.delete(oldest.value);
    }
    const created: ScopeEntry = { serverUrl: scope.serverUrl, subject: scope.subject, canvasIds: new Set() };
    next.set(key, created);
    return created;
  };

  const dropIfEmpty = (next: Map<string, ScopeEntry>, scope: RemoteSyncScope): void => {
    const key = scopeKeyOf(scope);
    if ((next.get(key)?.canvasIds.size ?? 0) === 0) next.delete(key);
  };

  return {
    async has(scope, canvasId) {
      await load();
      return scopes.get(scopeKeyOf(scope))?.canvasIds.has(canvasId) ?? false;
    },

    async add(scope, canvasId) {
      await transact((next) => {
        const entry = entryOf(next, scope);
        if (entry.canvasIds.has(canvasId)) return 0;
        // 边界：单个维度的待同步标记有上限；超出时丢弃最早的一条（用户再点一次即可）。
        if (entry.canvasIds.size >= MAX_PENDING_PER_SCOPE) {
          const oldest = entry.canvasIds.values().next();
          if (!oldest.done) entry.canvasIds.delete(oldest.value);
        }
        entry.canvasIds.add(canvasId);
        return 1;
      });
    },

    async remove(scope, canvasId) {
      await transact((next) => {
        const entry = next.get(scopeKeyOf(scope));
        if (entry === undefined || !entry.canvasIds.delete(canvasId)) return 0;
        dropIfEmpty(next, scope);
        return 1;
      });
    },

    async removeMany(scope, canvasIds) {
      // 先物化：迭代器可能来自调用方稍后才变的集合。
      const targets = new Set(canvasIds);
      if (targets.size === 0) return 0;
      return transact((next) => {
        const entry = next.get(scopeKeyOf(scope));
        if (entry === undefined) return 0;
        let removed = 0;
        for (const canvasId of targets) {
          if (entry.canvasIds.delete(canvasId)) removed += 1;
        }
        dropIfEmpty(next, scope);
        return removed;
      });
    }
  };
}

function cloneScopes(scopes: Map<string, ScopeEntry>): Map<string, ScopeEntry> {
  const next = new Map<string, ScopeEntry>();
  for (const [key, entry] of scopes) {
    next.set(key, { serverUrl: entry.serverUrl, subject: entry.subject, canvasIds: new Set(entry.canvasIds) });
  }
  return next;
}

/** 读文档里的集合：形状不符的条目逐条跳过（宁缺勿错）。 */
function parsePersisted(value: unknown): ScopeEntry[] {
  if (value === null || typeof value !== "object") return [];
  const raw = (value as { scopes?: unknown }).scopes;
  if (!Array.isArray(raw)) return [];
  const out: ScopeEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_SCOPES) break;
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.serverUrl !== "string" || record.serverUrl === "") continue;
    if (typeof record.subject !== "string") continue;
    const key = JSON.stringify([record.serverUrl, record.subject]);
    if (seen.has(key)) continue;
    seen.add(key);
    const canvasIds = Array.isArray(record.canvasIds)
      ? record.canvasIds
          .filter((canvasId): canvasId is string => typeof canvasId === "string" && canvasId !== "")
          .slice(0, MAX_PENDING_PER_SCOPE)
      : [];
    out.push({ serverUrl: record.serverUrl, subject: record.subject, canvasIds: new Set(canvasIds) });
  }
  return out;
}
