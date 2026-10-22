/**
 * 协作 writer lock（任务 3.7 / design D7 / spec「首版 room 服务采用单应用实例」）。
 *
 * 首版协作服务**只允许一个应用实例**接受 room 连接与命令。原因：Yjs room 的 authoring
 * 状态在内存中，多实例会各自形成分叉的 published Y.Doc 且没有跨实例广播机制。
 *
 * 因此用一个**部署级** writer lock 把限制显式化：抢不到锁的实例 readiness 失败，不得接受
 * 连接。**不**依赖 WebSocket sticky session 猜测正确性。
 *
 * 两个实现：
 * - `InMemoryWriterLock`：单进程/测试用；
 * - `DatabaseWriterLock`：由 adapter 提供的持久锁（跨进程）。
 */
import { hostname } from "node:os";
import type { YjsRepositoryHealth } from "./yjs-repository.js";

export type WriterLockAcquireResult =
  | { ok: true; release: () => Promise<void>; /** 接管时记录上一个（已失效）持有者，用于审计日志。 */ tookOverFrom?: string }
  | { ok: false; reason: string; holder?: string };

/** 实例标识约定：`<host>:<pid>`（见 `composition/storage-runtime.ts`）。 */
export function parseWriterLockInstance(instanceId: string): { host: string; pid: number } | null {
  const index = instanceId.lastIndexOf(":");
  if (index <= 0) return null;
  const pid = Number(instanceId.slice(index + 1));
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { host: instanceId.slice(0, index), pid };
}

/** 进程是否存活（`EPERM` 表示存在但无权限 → 视为存活）。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 持有者是否已失效、可以被接管（任务 11.8 / 缺陷 D3）。
 *
 * 只接受**可证明**的失效：持有者与本实例同主机、且该 pid 已不存在（进程被强杀留下的锁）。
 * 跨主机或标识不符（例如历史格式）一律保守判为存活，避免抢活进程的锁造成双 writer；
 * 这种情况下的恢复走部署文档的受控步骤。
 */
export function writerLockHolderIsStale(
  holder: string,
  options: { hostname?: string; isProcessAlive?: (pid: number) => boolean } = {}
): boolean {
  const parsed = parseWriterLockInstance(holder);
  if (!parsed) return false;
  const localHost = options.hostname ?? hostname();
  if (parsed.host !== localHost) return false;
  return !(options.isProcessAlive ?? isProcessAlive)(parsed.pid);
}

export type WriterLockHealth = {
  ok: boolean;
  holder?: string;
  since?: string;
  reason?: string;
};

export interface CanvasWriterLock {
  acquire(instanceId: string, now: string): Promise<WriterLockAcquireResult>;
  health(): Promise<WriterLockHealth>;
}

/**
 * 单进程内存锁。
 *
 * 「重入」语义：同一 `instanceId` 再次 acquire 视为成功（幂等），因此重启恢复或重复初始化
 * 不会把自己锁死。
 */
export class InMemoryWriterLock implements CanvasWriterLock {
  private holder: string | null = null;
  private since: string | null = null;

  async acquire(instanceId: string, now: string): Promise<WriterLockAcquireResult> {
    if (this.holder === null || this.holder === instanceId) {
      this.holder = instanceId;
      this.since = now;
      return {
        ok: true,
        release: async () => {
          if (this.holder === instanceId) {
            this.holder = null;
            this.since = null;
          }
        }
      };
    }
    return { ok: false, reason: `协作 writer lock 已被 ${this.holder} 持有`, holder: this.holder };
  }

  async health(): Promise<WriterLockHealth> {
    if (this.holder === null) {
      return { ok: false, reason: "尚无实例持有协作 writer lock" };
    }
    return { ok: true, holder: this.holder, since: this.since ?? undefined };
  }
}

export function createInMemoryWriterLock(): CanvasWriterLock {
  return new InMemoryWriterLock();
}

/**
 * 基于 Yjs 仓储健康检查 + 由 adapter 提供的 CAS 的部署级锁接口。
 *
 * adapter 侧实现方式是「条件写入一个固定文档/行」：例如 SQLite 的
 * `INSERT ... ON CONFLICT DO UPDATE WHERE holder = ?`，或 Mongo 的
 * `findOneAndUpdate({_id:"writer-lock", holder:null})`。抢不到即返回失败。
 *
 * 这里只定义契约，具体实现属于 adapter（与 Yjs 持久化同库，保证跨进程可见）。
 */
export type DurableWriterLockStore = {
  /** 尝试写入 holder；成功返回 true（含重入）。 */
  tryAcquire(instanceId: string, now: string): Promise<boolean>;
  /** 当前 holder；无人持有时返回 null。 */
  currentHolder(): Promise<{ instanceId: string; since: string } | null>;
  /** 释放（仅持有者可释放）。 */
  release(instanceId: string): Promise<void>;
  health(): Promise<YjsRepositoryHealth>;
};

export class DurableWriterLock implements CanvasWriterLock {
  constructor(private readonly store: DurableWriterLockStore) {}

  async acquire(instanceId: string, now: string): Promise<WriterLockAcquireResult> {
    // 记录取得前的持有者：成功后若与自身不同，说明是接管了失效持有者（D3 恢复路径）。
    const before = await this.store.currentHolder().catch(() => null);
    const acquired = await this.store.tryAcquire(instanceId, now);
    if (!acquired) {
      const current = await this.store.currentHolder();
      return {
        ok: false,
        reason: `协作 writer lock 已被 ${current?.instanceId ?? "其它实例"} 持有`,
        holder: current?.instanceId
      };
    }
    const tookOverFrom = before && before.instanceId !== instanceId ? before.instanceId : undefined;
    return { ok: true, release: () => this.store.release(instanceId), ...(tookOverFrom ? { tookOverFrom } : {}) };
  }

  async health(): Promise<WriterLockHealth> {
    const store = await this.store.health();
    if (!store.ok) return { ok: false, reason: store.reason ?? "存储不可用" };
    const current = await this.store.currentHolder();
    if (!current) return { ok: false, reason: "尚无实例持有协作 writer lock" };
    return { ok: true, holder: current.instanceId, since: current.since };
  }
}

export function createDurableWriterLock(store: DurableWriterLockStore): CanvasWriterLock {
  return new DurableWriterLock(store);
}
