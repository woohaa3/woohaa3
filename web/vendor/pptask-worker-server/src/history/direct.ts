import { extractExecutionResult, type ExecutionResult } from './projection.js';
import {
  createMemoryExecutionHistoryRepository,
  type ExecutionHistoryRepository,
} from './repository.js';

export type DirectExecutionState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type DirectExecutionRecord = {
  id: string;
  label?: string;
  state: DirectExecutionState;
  progress?: number;
  taskId?: string;
  metadata?: Record<string, unknown>;
  events: Array<{ at: string; stage: string; detail?: unknown }>;
  result?: ExecutionResult;
  error?: { name?: string; message: string; stack?: string };
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
  durationMs: number;
};

export type DirectExecutionRecorder = {
  snapshot(): DirectExecutionRecord;
  event(stage: string, detail?: unknown): void;
  setRunning(): void;
  succeed(value: unknown): void;
  fail(error: unknown): void;
};

export type DirectExecutionHistory = {
  start(input?: { label?: string; metadata?: Record<string, unknown> }): DirectExecutionRecorder;
  get(id: string): Promise<DirectExecutionRecord | undefined>;
  list(): Promise<DirectExecutionRecord[]>;
  subscribe(listener: (record: DirectExecutionRecord) => void): () => void;
  /** Resolves after queued storage writes complete, and rejects if one failed. */
  flush(): Promise<void>;
};

export async function createDirectExecutionHistory(options: {
  maxRecords?: number;
  maxEventsPerRecord?: number;
  repository?: ExecutionHistoryRepository<DirectExecutionRecord>;
  now?: () => number;
}): Promise<DirectExecutionHistory> {
  const now = options.now ?? Date.now;
  const maxRecords = options.maxRecords ?? 300;
  const maxEventsPerRecord = options.maxEventsPerRecord ?? 200;
  const repository = options.repository ?? createMemoryExecutionHistoryRepository<DirectExecutionRecord>();
  const stored = await repository.list({ limit: maxRecords });
  const records = new Map(stored.records.map(record => [record.id, record]));
  const listeners = new Set<(record: DirectExecutionRecord) => void>();
  let saveQueue = Promise.resolve();
  let saveFailure: unknown;
  const stamp = () => new Date(now()).toISOString();
  const list = () => [...records.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const schedule = (operation: () => Promise<void>) => {
    saveQueue = saveQueue.then(operation).catch(error => {
      saveFailure ??= error;
    });
  };
  const publish = (record: DirectExecutionRecord) => {
    for (const listener of listeners) {
      try { listener(record); } catch { /* observers cannot affect execution */ }
    }
    schedule(() => repository.upsert(record));
  };
  const update = (id: string, mutate: (current: DirectExecutionRecord) => DirectExecutionRecord) => {
    const current = records.get(id);
    if (!current) return;
    const record = mutate(current);
    records.set(id, record);
    while (records.size > maxRecords) {
      const id = oldestId(records);
      records.delete(id);
      schedule(() => repository.delete(id));
    }
    publish(record);
  };

  return {
    start(input = {}) {
      const at = stamp();
      const initial: DirectExecutionRecord = {
        id: executionId(), label: input.label, state: 'pending', metadata: input.metadata,
        events: [{ at, stage: 'execution.created' }], createdAt: at, updatedAt: at, durationMs: 0,
      };
      records.set(initial.id, initial);
      publish(initial);
      const mutate = (change: (current: DirectExecutionRecord) => DirectExecutionRecord) => update(initial.id, current => {
        const next = change(current);
        return { ...next, durationMs: Math.max(0, Date.parse(next.finishedAt ?? stamp()) - Date.parse(next.startedAt ?? next.createdAt)) };
      });
      return {
        snapshot: () => records.get(initial.id)!,
        event: (stage, detail) => mutate(current => {
          const values = detail && typeof detail === 'object' && !Array.isArray(detail)
            ? detail as Record<string, unknown>
            : undefined;
          const progress = typeof values?.progress === 'number' && Number.isFinite(values.progress)
            ? values.progress
            : current.progress;
          const taskId = typeof values?.taskId === 'string' && values.taskId
            ? values.taskId
            : current.taskId;
          return {
            ...current,
            progress,
            taskId,
            updatedAt: stamp(),
            events: [...current.events, { at: stamp(), stage, detail }].slice(-maxEventsPerRecord),
          };
        }),
        setRunning: () => mutate(current => ({ ...current, state: 'running', startedAt: current.startedAt ?? stamp(), updatedAt: stamp() })),
        succeed: value => {
          const finishedAt = stamp();
          mutate(current => ({ ...current, state: 'succeeded', progress: 1, finishedAt, updatedAt: finishedAt, result: extractExecutionResult(value) }));
        },
        fail: error => {
          const finishedAt = stamp();
          const value = error instanceof Error ? error : new Error(String(error));
          mutate(current => ({ ...current, state: 'failed', finishedAt, updatedAt: finishedAt, error: { name: value.name, message: value.message, stack: value.stack } }));
        },
      };
    },
    get: async id => records.get(id),
    list: async () => list(),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    flush: async () => {
      await saveQueue;
      if (saveFailure) throw saveFailure;
    },
  };
}

function executionId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `execution-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function oldestId(records: Map<string, DirectExecutionRecord>): string {
  return [...records.values()].reduce((oldest, record) => (
    record.createdAt.localeCompare(oldest.createdAt) < 0 ? record : oldest
  )).id;
}
