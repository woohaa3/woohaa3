/**
 * Event-driven dispatch runtime — acceptance for
 * change: replace-worker-db-polling-with-dispatcher (tasks 6.x / 7.x).
 *
 * These tests pin the observable contract: no idle claim polling, immediate
 * wake on submit, capacity gating, durable delayed retry, and graceful stop.
 */
import { describe, expect, it, afterEach } from 'vitest';
import type { ImageModelV4Result } from '@ai-sdk/provider';
import {
  createMemoryJobRepository,
  createPptaskProvider,
  type PptaskJobRepository,
  type PptaskProvider,
} from '@sdppp/pptask';
import { createMemoryPptaskTaskStore } from '../../src/memory-task-store.js';
import { createPptaskWorkerServer, type PptaskWorkerServer } from '../../src/server.js';
import type { PptaskTaskStore } from '../../src/task-store/types.js';

type Outcome = { kind: 'pending' } | { kind: 'throw'; message: string } | { kind: 'completed' };

function scriptedProvider(jobRepository: PptaskJobRepository, script: Outcome[]): PptaskProvider {
  let index = 0;
  return createPptaskProvider({
    providerId: 'fake',
    jobRepository,
    pollIntervalMs: 1,
    imageModel: (modelId) => ({
      maxImagesPerCall: 1,
      async doStart() {
        return { operation: { id: 'op-1' } };
      },
      async doStatus(): Promise<any> {
        const outcome = script[Math.min(index, script.length - 1)];
        index += 1;
        if (outcome.kind === 'throw') throw new Error(outcome.message);
        if (outcome.kind === 'pending') return { status: 'pending', phase: 'running', progress: 0.5 };
        const result: ImageModelV4Result = {
          images: [new Uint8Array([1])],
          warnings: [],
          response: { timestamp: new Date(), modelId, headers: undefined },
        };
        return { status: 'completed', ...result };
      },
      async doCancel() {},
    }),
  });
}

/** Counts claim/heartbeat calls without changing store behaviour. */
function instrument(store: PptaskTaskStore): {
  store: PptaskTaskStore;
  counts: () => { claims: number; heartbeats: number };
} {
  const counts = { claims: 0, heartbeats: 0 };
  return {
    counts: () => ({ ...counts }),
    store: {
      ...store,
      async claimReady(input) {
        counts.claims += 1;
        return store.claimReady(input);
      },
      async claimDue(input) {
        counts.claims += 1;
        return store.claimDue(input);
      },
      async heartbeat(input) {
        counts.heartbeats += 1;
        return store.heartbeat(input);
      },
    },
  };
}

async function waitFor<T>(probe: () => T, timeout = 3_000): Promise<Exclude<Awaited<T>, null | undefined | false>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value as Exclude<Awaited<T>, null | undefined | false>;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

const servers: PptaskWorkerServer[] = [];
afterEach(async () => {
  await Promise.allSettled(servers.map((server) => server.close()));
  servers.length = 0;
});

async function openServer(options: {
  taskStore: PptaskTaskStore;
  jobRepository: PptaskJobRepository;
  provider: PptaskProvider;
  concurrency?: number;
  leaseMs?: number;
}): Promise<PptaskWorkerServer> {
  const server = await createPptaskWorkerServer({
    taskStore: options.taskStore,
    jobRepository: options.jobRepository,
    resolveProvider: (id) => (id === 'fake' ? options.provider : undefined),
    concurrency: options.concurrency,
    leaseMs: options.leaseMs,
    retryBaseMs: 20,
  });
  servers.push(server);
  return server;
}

function image(key: string) {
  return { key, providerId: 'fake', modelType: 'image' as const, modelId: 'demo', input: { prompt: 'hi' } };
}

describe('event-driven dispatch runtime', () => {
  it('submits and completes without any idle polling', async () => {
    const jobRepository = createMemoryJobRepository();
    const provider = scriptedProvider(jobRepository, [{ kind: 'pending' }, { kind: 'completed' }]);
    const counted = instrument(createMemoryPptaskTaskStore());
    const server = await openServer({ taskStore: counted.store, jobRepository, provider });

    await server.submit(image('req-1'));
    const task = await waitFor(async () => {
      const current = await server.status('req-1');
      return current?.status === 'completed' ? current : null;
    });
    expect(task.attempt).toBe(1);

    // Idle observation window: no task, no deadline → no claim query.
    const settled = counted.counts();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const idle = counted.counts();
    expect(idle.claims).toBe(settled.claims);
    // Heartbeats only happen while a task is active.
    expect(idle.heartbeats).toBe(settled.heartbeats);
    expect(idle.heartbeats).toBe(0);
  });

  it('caps concurrency and drains the durable backlog as capacity frees', async () => {
    const jobRepository = createMemoryJobRepository();
    const provider = scriptedProvider(jobRepository, [{ kind: 'pending' }, { kind: 'completed' }]);
    const store = createMemoryPptaskTaskStore();
    const server = await openServer({ taskStore: store, jobRepository, provider, concurrency: 2 });

    await Promise.all(['a', 'b', 'c', 'd'].map((key) => server.submit(image(key))));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.counters().active).toBeLessThanOrEqual(2);

    // All four eventually complete with no more than two active at once.
    await waitFor(async () => {
      const records = await Promise.all(['a', 'b', 'c', 'd'].map((key) => server.status(key)));
      return records.every((record) => record?.status === 'completed') ? true : null;
    });
    expect(server.counters().capacity).toBe(2);
  });

  it('holds a delayed retry until its durable nextRunAt deadline', async () => {
    const jobRepository = createMemoryJobRepository();
    const provider = scriptedProvider(jobRepository, [
      { kind: 'throw', message: 'request timeout' },
      { kind: 'throw', message: 'request timeout' },
      { kind: 'throw', message: 'request timeout' },
      { kind: 'throw', message: 'request timeout' },
      { kind: 'completed' },
    ]);
    const store = createMemoryPptaskTaskStore();
    const server = await openServer({ taskStore: store, jobRepository, provider });

    await server.submit(image('retry-1'));
    const rescheduled = await waitFor(async () => {
      const current = await store.find('retry-1');
      return current?.status === 'queued' && current.nextRunAt ? current : null;
    });
    const deadline = rescheduled.nextRunAt!.getTime();
    expect(deadline).toBeGreaterThan(Date.now());

    // Not claimed again before the durable deadline.
    const claimedEarly = await store.find('retry-1');
    expect(claimedEarly?.attempt).toBe(1);

    const task = await waitFor(async () => {
      const current = await server.status('retry-1');
      return current?.status === 'completed' ? current : null;
    });
    expect(task.attempt).toBe(2);
  });

  it('stops accepting new claims on shutdown but leaves executing work durable', async () => {
    const jobRepository = createMemoryJobRepository();
    const provider = scriptedProvider(jobRepository, [{ kind: 'pending' }]);
    const store = createMemoryPptaskTaskStore();
    const server = await openServer({ taskStore: store, jobRepository, provider });

    await server.submit(image('running'));
    await waitFor(async () => {
      const current = await store.find('running');
      return current?.status === 'executing' ? current : null;
    });

    server.stop();
    await server.submit(image('blocked'));
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Grace did not finish the active task: it stays executing with a lease.
    const active = await store.find('running');
    expect(active?.status).toBe('executing');
    expect(active?.leaseUntil).toBeTruthy();
    // The unclaimed task stays durable queued.
    expect((await store.find('blocked'))?.status).toBe('submitting');

    server.abortAll();
    await server.drained();
  });

  it('作业记录不在 worker 仓库时，drive 失败仍上报 task-failed（执行历史/画布才能结算）', async () => {
    // 远端托管 Provider 的作业属于扩展自己的 engine，worker 的 jobRepository 里查不到；
    // 此前这条分支只把调度行标 failed、不上报，导致执行历史永远停在 running，
    // 画布节点也就永远显示「执行中」。
    const workerRepository = createMemoryJobRepository();
    const providerRepository = createMemoryJobRepository();
    const provider = scriptedProvider(providerRepository, [{ kind: 'throw', message: 'boom' }]);
    const store = createMemoryPptaskTaskStore();
    const server = await createPptaskWorkerServer({
      taskStore: store,
      jobRepository: workerRepository,
      resolveProvider: (id) => (id === 'fake' ? provider : undefined),
      retryBaseMs: 20,
    });
    servers.push(server);
    await server.submit(image('orphan-job'));
    const task = await waitFor(async () => {
      const current = await store.find('orphan-job');
      return current?.status === 'failed' ? current : null;
    });
    expect(task.status).toBe('failed');
    const projected = await waitFor(async () => {
      const record = await server.history.get('orphan-job');
      return record?.state === 'failed' ? record : null;
    });
    expect(projected.events.some((event) => event.stage === 'worker.task-failed')).toBe(true);
    // 原因也要落到记录上：历史/画布据此给出可读的失败说明，而不是只有「失败」。
    expect(projected.error?.message).toBe('boom');
  });

  it('does not roll back a durable submit when the notifier fails', async () => {
    const jobRepository = createMemoryJobRepository();
    const provider = scriptedProvider(jobRepository, [{ kind: 'completed' }]);
    const store = createMemoryPptaskTaskStore();
    const server = await createPptaskWorkerServer({
      taskStore: store,
      jobRepository,
      resolveProvider: () => provider,
      // Short sweep so the recovery path (not the lost hint) is what dispatches.
      recoveryIntervalMs: 40,
      recoveryJitterMs: 0,
      notifier: {
        publish() {
          throw new Error('notification transport down');
        },
        subscribe() {
          return () => undefined;
        },
      },
    });
    servers.push(server);

    const result = await server.submit(image('notify-fail'));
    expect(result.created).toBe(true);
    // The record survives; recovery (safety sweep/startup) will dispatch it.
    const record = await store.find('notify-fail');
    expect(record?.status).not.toBe('failed');
    await waitFor(async () => {
      const current = await server.status('notify-fail');
      return current?.status === 'completed' ? current : null;
    });
  });
});
