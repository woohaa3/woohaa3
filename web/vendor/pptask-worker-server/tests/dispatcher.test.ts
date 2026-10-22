import { describe, expect, it } from 'vitest';
import { createMemoryPptaskTaskStore } from '../src/memory-task-store.js';
import {
  createInProcessDispatchNotifier,
  createPptaskTaskDispatcher,
} from '../src/dispatcher.js';
import type { PptaskTaskRecord, PptaskTaskStore } from '../src/task-store/types.js';

const LEASE_MS = 60_000;

function date(ms: number): Date {
  return new Date(ms);
}

/** Wraps a store to count claim queries without changing its behaviour. */
function countingStore(store: PptaskTaskStore): {
  store: PptaskTaskStore;
  counts: () => { claims: number };
} {
  let claims = 0;
  return {
    counts: () => ({ claims }),
    store: {
      ...store,
      async claimReady(input) {
        claims += 1;
        return store.claimReady(input);
      },
      async claimDue(input) {
        claims += 1;
        return store.claimDue(input);
      },
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Executor that records start order, waits on a gate, then settles. */
function gatedExecutor(
  store: PptaskTaskStore,
  started: string[],
  gates: Map<string, ReturnType<typeof deferred>>,
) {
  return async (record: PptaskTaskRecord): Promise<void> => {
    started.push(record.key);
    const gate = deferred();
    gates.set(record.key, gate);
    await gate.promise;
    await store.save({ ...record, status: 'completed', updatedAt: new Date() });
  };
}

async function submit(store: PptaskTaskStore, key: string, at = date(1000)): Promise<void> {
  await store.submit({ key, providerId: 'fake', now: at });
}

async function waitFor(probe: () => boolean, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

const quiet = { recoveryIntervalMs: 60_000 } as const;

describe('createPptaskTaskDispatcher', () => {
  it('is idle after startup recovery: no claim query until an explicit wake', async () => {
    const counted = countingStore(createMemoryPptaskTaskStore());
    const dispatcher = createPptaskTaskDispatcher({
      taskStore: counted.store,
      execute: async () => undefined,
      ...quiet,
    });
    dispatcher.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const before = counted.counts().claims;
    // Startup recovery performs a bounded initial probe and then goes quiet.
    expect(before).toBeGreaterThanOrEqual(1);
    expect(before).toBeLessThanOrEqual(3);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(counted.counts().claims).toBe(before);
    await dispatcher.close();
  });

  it('claims only up to capacity and keeps a durable backlog', async () => {
    const store = createMemoryPptaskTaskStore();
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const started: string[] = [];
    const dispatcher = createPptaskTaskDispatcher({
      taskStore: store,
      concurrency: 2,
      leaseMs: LEASE_MS,
      execute: gatedExecutor(store, started, gates),
      ...quiet,
    });
    dispatcher.start();
    await Promise.all([submit(store, 'a'), submit(store, 'b'), submit(store, 'c'), submit(store, 'd')]);
    dispatcher.wake('submitted');

    await waitFor(() => started.length === 2);
    expect(dispatcher.counters().active).toBe(2);
    // No prefetch past capacity: the backlog stays claimable in the store.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started).toHaveLength(2);

    gates.get('a')!.resolve();
    await waitFor(() => started.length === 3);
    expect(started).toContain('c');
    gates.get('b')!.resolve();
    await waitFor(() => started.length === 4);
    expect(started).toContain('d');
    // Capacity is never exceeded while draining the backlog.
    expect(dispatcher.counters().active).toBeLessThanOrEqual(2);
    gates.get('c')!.resolve();
    gates.get('d')!.resolve();
    await dispatcher.drained();
    await waitFor(() => dispatcher.counters().active === 0);
    expect((await store.find('a'))?.status).toBe('completed');
    expect((await store.find('d'))?.status).toBe('completed');
    await dispatcher.close();
  });

  it('coalesces a wake storm into a single pending drain', async () => {
    const store = createMemoryPptaskTaskStore();
    const gate = deferred();
    const dispatcher = createPptaskTaskDispatcher({
      taskStore: store,
      execute: async () => { await gate.promise; },
      ...quiet,
    });
    dispatcher.start();
    await Promise.all([submit(store, 'a'), submit(store, 'b'), submit(store, 'c')]);
    for (let index = 0; index < 25; index += 1) dispatcher.wake('submitted');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(dispatcher.counters().coalescedWakeCount).toBeGreaterThan(0);
    gate.resolve();
    await dispatcher.close();
  });

  it('arms a single timer for the nearest delayed retry deadline', async () => {
    const store = createMemoryPptaskTaskStore();
    const started: string[] = [];
    const dispatcher = createPptaskTaskDispatcher({
      taskStore: store,
      execute: async (record) => { started.push(record.key); },
      ...quiet,
    });
    dispatcher.start();
    await submit(store, 'retry');
    // Durable future deadline, then arrange the timer the way the executor does.
    const record = (await store.find('retry'))!;
    const nextRunAt = new Date(Date.now() + 60);
    await store.save({ ...record, status: 'queued', nextRunAt });
    dispatcher.schedule('retry', nextRunAt);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toEqual([]); // not claimed before its deadline
    await waitFor(() => started.includes('retry'));
    await dispatcher.close();
  });

  it('stopAccepting prevents new claims while draining in-flight work', async () => {
    const store = createMemoryPptaskTaskStore();
    const gate = deferred();
    const started: string[] = [];
    const dispatcher = createPptaskTaskDispatcher({
      taskStore: store,
      leaseMs: LEASE_MS,
      execute: async (record) => {
        started.push(record.key);
        await gate.promise;
        await store.save({ ...record, status: 'completed', updatedAt: new Date() });
      },
      ...quiet,
    });
    dispatcher.start();
    await submit(store, 'running');
    dispatcher.wake('submitted');
    await waitFor(() => started.length === 1);

    dispatcher.stopAccepting();
    await submit(store, 'blocked');
    dispatcher.wake('submitted');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(started).toEqual(['running']);

    gate.resolve();
    await dispatcher.drained();
    // Grace finished the active task; the unclaimed task stays durable queued.
    expect((await store.find('running'))?.status).toBe('completed');
    expect((await store.find('blocked'))?.status).toBe('submitting');
    await dispatcher.close();
  });

  it('shares one notifier between publishers and the dispatcher', async () => {
    const store = createMemoryPptaskTaskStore();
    const notifier = createInProcessDispatchNotifier();
    const started: string[] = [];
    const dispatcher = createPptaskTaskDispatcher({
      taskStore: store,
      notifier,
      execute: async (record) => { started.push(record.key); },
      ...quiet,
    });
    dispatcher.start();
    await submit(store, 'hinted');
    notifier.publish({ reason: 'submitted', key: 'hinted' });
    await waitFor(() => started.includes('hinted'));
    await dispatcher.close();
  });
});
