/**
 * Mongo Yjs 仓储：部署级 writer lock store
 * （change: 2026-10-13-add-offline-canvas-migration-and-mongodb-backend，任务 2.1/2.2）。
 *
 * 与 `storage/sqlite/yjs-writer-lock.ts` 同构：只依赖受控的锁方法（结构类型），
 * 不复制连接 owner；锁与 Yjs 持久化同库，保证跨进程可见。
 */
import type { DurableWriterLockStore } from "../../sync/index.js";
import type { YjsRepositoryHealth } from "../../sync/index.js";

/** 提供 writer lock 语义的 repository 结构端口。 */
export type WriterLockRepositoryPort = {
  tryAcquireWriterLock(instanceId: string, now: string): Promise<boolean>;
  currentWriterLock(): Promise<{ instanceId: string; since: string } | null>;
  releaseWriterLock(instanceId: string): Promise<void>;
  health(): Promise<YjsRepositoryHealth>;
};

export function createMongoWriterLockStore(repository: WriterLockRepositoryPort): DurableWriterLockStore {
  return {
    tryAcquire: (instanceId, now) => repository.tryAcquireWriterLock(instanceId, now),
    currentHolder: () => repository.currentWriterLock(),
    release: (instanceId) => repository.releaseWriterLock(instanceId),
    health: () => repository.health()
  };
}
