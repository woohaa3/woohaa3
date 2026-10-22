/**
 * SQLite Yjs 仓储：部署级 writer lock store
 * （自 `yjs.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R22）。
 *
 * 与 repository 同库、同连接语义；store 只依赖受控的锁方法（结构类型），不复制连接 owner。
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

export function createSqliteWriterLockStore(repository: WriterLockRepositoryPort): DurableWriterLockStore {
  return {
    tryAcquire: (instanceId, now) => repository.tryAcquireWriterLock(instanceId, now),
    currentHolder: () => repository.currentWriterLock(),
    release: (instanceId) => repository.releaseWriterLock(instanceId),
    health: () => repository.health()
  };
}
