import { randomUUID } from 'node:crypto';
import type {
  PptaskTaskRecord,
  PptaskTaskStore,
} from './task-store/types.js';
import { classifyTaskDispatchState, isTaskTerminal } from './task-store/types.js';

function cloneRecord(record: PptaskTaskRecord): PptaskTaskRecord {
  return {
    ...record,
    ...(record.leaseUntil ? { leaseUntil: new Date(record.leaseUntil) } : {}),
    ...(record.nextRunAt ? { nextRunAt: new Date(record.nextRunAt) } : {}),
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

/** Stable queue order: earliest nextRunAt, then createdAt, then key. */
function compareQueueOrder(left: PptaskTaskRecord, right: PptaskTaskRecord): number {
  return (
    (left.nextRunAt?.getTime() ?? left.createdAt.getTime()) -
      (right.nextRunAt?.getTime() ?? right.createdAt.getTime()) ||
    left.createdAt.getTime() - right.createdAt.getTime() ||
    left.key.localeCompare(right.key)
  );
}

/**
 * The next deadline a dispatch timer must wake for, or null when the record is
 * already ready (no future deadline) or has no deadline at all.
 */
function nextDeadline(record: PptaskTaskRecord, now: Date): number | null {
  const candidate =
    record.status === 'executing'
      ? record.leaseUntil?.getTime()
      : record.nextRunAt?.getTime();
  if (candidate === undefined) return null;
  return candidate > now.getTime() ? candidate : null;
}

function claimFrom(
  records: Map<string, PptaskTaskRecord>,
  publish: (record: PptaskTaskRecord) => void,
  input: { now: Date; leaseUntil: Date },
): PptaskTaskRecord | null {
  const ready = [...records.values()]
    .filter((record) => classifyTaskDispatchState(record, input.now) === 'ready')
    .sort(compareQueueOrder)[0];
  if (!ready) return null;
  const claimed: PptaskTaskRecord = {
    ...ready,
    claimToken: randomUUID(),
    status: 'executing',
    leaseUntil: new Date(input.leaseUntil),
    attempt: ready.attempt + 1,
    updatedAt: new Date(input.now),
  };
  records.set(ready.key, claimed);
  publish(claimed);
  return cloneRecord(claimed);
}

/**
 * In-memory reference implementation of `PptaskTaskStore`, for tests and
 * single-process tools. Map mutations are atomic per call because the claim
 * loop runs in one event loop. Multi-process deployments need a store backed
 * by real transactions (see the contract requirements in task-store/types.ts).
 */
export function createMemoryPptaskTaskStore(): PptaskTaskStore {
  const records = new Map<string, PptaskTaskRecord>();
  const listeners = new Set<(record: PptaskTaskRecord) => void>();
  const publish = (record: PptaskTaskRecord): void => {
    for (const listener of listeners) {
      try { listener(cloneRecord(record)); } catch { /* observers must not affect persistence */ }
    }
  };

  return {
    async submit(input) {
      const current = records.get(input.key);
      if (current) return { record: cloneRecord(current), created: false };
      const created: PptaskTaskRecord = {
        key: input.key,
        providerId: input.providerId,
        ...(input.params !== undefined ? { params: structuredClone(input.params) } : {}),
        ...(input.context !== undefined ? { context: structuredClone(input.context) } : {}),
        ...(input.ownerId ? { ownerId: input.ownerId } : {}),
        ...(input.state !== undefined ? { state: structuredClone(input.state) } : {}),
        status: input.state !== undefined ? 'queued' : 'submitting',
        attempt: 0,
        consecutiveFailures: 0,
        createdAt: new Date(input.now),
        updatedAt: new Date(input.now),
      };
      records.set(input.key, created);
      publish(created);
      return { record: cloneRecord(created), created: true };
    },

    async find(key) {
      const record = records.get(key);
      return record ? cloneRecord(record) : null;
    },

    async claimReady(input) {
      return claimFrom(records, publish, input);
    },

    async claimDue(input) {
      return claimFrom(records, publish, input);
    },

    async nextWakeAt(input) {
      let earliest: number | null = null;
      for (const record of records.values()) {
        if (isTaskTerminal(record.status)) continue;
        const deadline = nextDeadline(record, input.now);
        if (deadline === null) continue;
        if (earliest === null || deadline < earliest) earliest = deadline;
      }
      return earliest === null ? null : new Date(earliest);
    },

    async heartbeat(input) {
      const current = records.get(input.key);
      if (!current || current.claimToken !== input.claimToken || current.status !== 'executing') {
        return false;
      }
      const renewed: PptaskTaskRecord = {
        ...current,
        leaseUntil: new Date(input.leaseUntil),
        updatedAt: new Date(input.now),
      };
      records.set(input.key, renewed);
      publish(renewed);
      return true;
    },

    async save(record) {
      const current = records.get(record.key);
      if (current && current.claimToken !== record.claimToken) return;
      const saved = cloneRecord(record);
      records.set(record.key, saved);
      publish(saved);
    },

    async cancel(key, now) {
      const current = records.get(key);
      if (!current) return null;
      if (isTaskTerminal(current.status)) return cloneRecord(current);
      const cancelled: PptaskTaskRecord = {
        ...current,
        // A fresh token fences out the current claimant's heartbeats and saves.
        claimToken: randomUUID(),
        status: 'cancelled',
        leaseUntil: undefined,
        nextRunAt: undefined,
        updatedAt: new Date(now),
      };
      records.set(key, cancelled);
      publish(cancelled);
      return cloneRecord(cancelled);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
