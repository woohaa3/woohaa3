import type { ExecutionHistoryRepository, ExecutionHistoryStoredRecord } from '../history/repository.js';
import { createMemoryExecutionHistoryRepository } from '../history/repository.js';
import { createMemoryPptaskTaskStore } from '../memory-task-store.js';
import type { PptaskTaskStore } from '../task-store/types.js';

/**
 * Application-held composition of the runtime's storage: the worker's durable
 * task store plus namespaced execution-history projections. A physical
 * backend can serve both through one connection while exposing separate
 * repositories. Use namespace to isolate Pptask projections from
 * application-owned execution records.
 */
export type PptaskStorage = {
  taskStore: PptaskTaskStore;
  history<RECORD extends ExecutionHistoryStoredRecord>(
    namespace: string,
  ): ExecutionHistoryRepository<RECORD>;
  close?(): Promise<void>;
};

/**
 * In-memory storage for tests, short-lived tools, and single-process
 * deployments. Durable deployments inject a database-backed task store and
 * history repository (unique key index + transactional claims).
 */
export function createMemoryPptaskStorage(): PptaskStorage {
  const histories = new Map<string, ExecutionHistoryRepository<ExecutionHistoryStoredRecord>>();
  return {
    taskStore: createMemoryPptaskTaskStore(),
    history<RECORD extends ExecutionHistoryStoredRecord>(namespace: string): ExecutionHistoryRepository<RECORD> {
      if (!namespace.trim()) throw new Error('Pptask storage history namespace must not be empty');
      let repository = histories.get(namespace);
      if (!repository) {
        repository = createMemoryExecutionHistoryRepository();
        histories.set(namespace, repository);
      }
      return repository as ExecutionHistoryRepository<RECORD>;
    },
  };
}
