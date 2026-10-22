import type {
  PptaskJobRecord,
  PptaskJobRepository,
  PptaskJobRepositoryChange,
} from '../core/types.ts';
import { clone, matchesFilter } from './shared.ts';

export function createMemoryJobRepository(): PptaskJobRepository {
  const records = new Map<string, PptaskJobRecord>();
  const listeners = new Set<(event: PptaskJobRepositoryChange) => void>();
  const publish = (event: PptaskJobRepositoryChange): void => {
    for (const listener of listeners) {
      try { listener(event); } catch { /* observers must not affect persistence */ }
    }
  };
  return {
    async get<RESULT>(id: string) {
      return clone(records.get(id)) as PptaskJobRecord<RESULT> | undefined;
    },
    async create(record) {
      // Plain insert: dedup is a scheduling policy owned by the worker layer,
      // not a job-repository concern.
      records.set(record.id, clone(record));
      publish({ type: 'created', job: clone(record) });
      return { record: clone(record), created: true };
    },
    async put(record) {
      records.set(record.id, clone(record));
      publish({ type: 'updated', job: clone(record) });
    },
    async update<RESULT>(id: string, updater: (record: PptaskJobRecord<RESULT>) => PptaskJobRecord<RESULT>) {
      const current = records.get(id);
      if (!current) throw new Error(`Job not found: ${id}`);
      const updated = updater(clone(current) as PptaskJobRecord<RESULT>);
      records.set(id, clone(updated));
      publish({ type: 'updated', job: clone(updated) });
      return clone(updated);
    },
    async list(filter) {
      return Array.from(records.values()).filter(record => matchesFilter(record, filter)).map(clone);
    },
    async delete(id) {
      const record = records.get(id);
      if (!record) return;
      records.delete(id);
      publish({ type: 'deleted', job: clone(record) });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
