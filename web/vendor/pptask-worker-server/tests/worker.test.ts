import { afterEach, describe, expect, it } from 'vitest';
import type { ImageModelV4Result, LanguageModelV4GenerateResult, LanguageModelV4StreamResult } from '@ai-sdk/provider';
import {
  createMemoryJobRepository,
  createPptaskProvider,
  reportPptaskExecution,
  type PptaskJobRecord,
  type PptaskJobRepository,
  subscribePptaskExecutions,
  type PptaskProvider,
} from '@sdppp/pptask';
import { createMemoryPptaskTaskStore } from '../src/memory-task-store.js';
import { createPptaskWorker } from '../src/worker.js';
import type { PptaskWorker, PptaskWorkerSubmitInput } from '../src/worker.js';

type ScriptedOutcome =
  | { kind: 'pending' }
  | { kind: 'error'; message: string }
  | { kind: 'throw'; message: string }
  | { kind: 'completed' };

function createScriptedProvider(options: {
  jobRepository: PptaskJobRepository;
  script: ScriptedOutcome[];
  streamText?: string;
}) {
  const counts = { starts: 0, statuses: 0, cancels: 0, streamDeltas: 0 };
  let index = 0;
  const provider: PptaskProvider = createPptaskProvider({
    providerId: 'fake',
    jobRepository: options.jobRepository,
    pollIntervalMs: 1,
    imageModel: (modelId) => ({
      maxImagesPerCall: 1,
      async doStart() {
        counts.starts += 1;
        return { operation: { id: `op-${counts.starts}` } };
      },
      async doStatus(): Promise<any> {
        counts.statuses += 1;
        // The last outcome repeats forever, so "pending" can stall a drive.
        const outcome = options.script[Math.min(index, options.script.length - 1)];
        index += 1;
        if (outcome.kind === 'throw') throw new Error(outcome.message);
        if (outcome.kind === 'error') return { status: 'error', error: outcome.message };
        if (outcome.kind === 'pending') return { status: 'pending', phase: 'running', progress: 0.5 };
        const result: ImageModelV4Result = {
          images: [new Uint8Array([1])],
          warnings: [],
          response: { timestamp: new Date(), modelId, headers: undefined },
        };
        return { status: 'completed', ...result };
      },
      async doCancel() {
        counts.cancels += 1;
      },
    }),
    languageModel: (modelId) => ({
      supportedUrls: {},
      async doStream(): Promise<LanguageModelV4StreamResult> {
        const chunks = ['你', '好'];
        const id = 't1';
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id });
            for (const delta of chunks) controller.enqueue({ type: 'text-delta', id, delta });
            controller.enqueue({ type: 'text-end', id });
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop' as const, raw: 'stop' },
              usage: {
                inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 2, text: 2, reasoning: undefined },
              },
            });
            controller.close();
          },
        });
        return { stream };
      },
      async doGenerate(): Promise<LanguageModelV4GenerateResult> {
        return {
          content: [{ type: 'text' as const, text: options.streamText ?? 'answer' }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
          response: { timestamp: new Date(), modelId, headers: undefined },
        };
      },
    }),
  });
  return { provider, counts };
}

async function waitFor<T>(
  probe: () => T,
  timeout = 3_000,
): Promise<Exclude<Awaited<T>, null | undefined | false>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value as Exclude<Awaited<T>, null | undefined | false>;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timed out');
}

describe('createPptaskWorker', () => {
  const workers: PptaskWorker[] = [];
  const stops: Array<() => Promise<void>> = [];

  function track(worker: PptaskWorker): PptaskWorker {
    workers.push(worker);
    stops.push(() => {
      worker.stop();
      return worker.drained();
    });
    return worker;
  }

  afterEach(async () => {
    for (const worker of workers) worker.stop();
    await Promise.allSettled(stops.map((stop) => stop()));
    workers.length = 0;
    stops.length = 0;
  });

  function baseOptions(
    taskStore: ReturnType<typeof createMemoryPptaskTaskStore>,
    jobRepository: PptaskJobRepository,
    provider: PptaskProvider,
  ) {
    return {
      taskStore,
      jobRepository,
      resolveProvider: (id: string | undefined) => (id === 'fake' ? provider : undefined),
      retryBaseMs: 10,
    };
  }

  function imageSubmit(key: string, input: unknown = { prompt: 'hi' }): PptaskWorkerSubmitInput {
    return { key, providerId: 'fake', modelType: 'image', modelId: 'demo', input };
  }

  it('does not call a provider for a stale queued source and parks an existing receipt across restart', async () => {
    const taskStore = createMemoryPptaskTaskStore();
    const jobRepository = createMemoryJobRepository();
    const { provider, counts } = createScriptedProvider({ jobRepository, script: [{ kind: 'completed' }] });
    const events: Array<{ stage: string; detail?: unknown }> = [];
    const options = { ...baseOptions(taskStore, jobRepository, provider),
      resolveProvider: () => { throw Object.assign(new Error('source rotated'), { sourceStale: true }); },
      reporter: (event: { stage: string; detail?: unknown }) => { events.push(event); },
    };
    await taskStore.submit({ key: 'stale-queue', providerId: 'fake', params: { modelType: 'image', modelId: 'demo', input: {} }, now: new Date() });
    const snapshot = { jobId: 'original-job', record: { id: 'original-job', operation: { id: 'upstream-receipt' } } };
    await taskStore.submit({ key: 'stale-receipt', providerId: 'fake', params: { modelType: 'image', modelId: 'demo', input: {} }, state: snapshot, now: new Date() });
    const worker = track(createPptaskWorker(options));
    await waitFor(async () => (await taskStore.find('stale-queue'))?.status === 'failed');
    const parked = await waitFor(async () => {
      const task = await taskStore.find('stale-receipt');
      return task?.status === 'executing' && !task.leaseUntil ? task : null;
    });
    expect(parked.state).toEqual(snapshot);
    expect(events.some(event => (event.detail as { sourceStale?: boolean })?.sourceStale)).toBe(true);
    worker.stop(); await worker.drained();
    track(createPptaskWorker(baseOptions(taskStore, jobRepository, provider)));
    // A healthy/new provider after restart must never resubmit the parked receipt.
    await waitFor(async () => (await taskStore.find('stale-receipt'))?.status === 'executing');
    expect(await taskStore.claimReady({ now: new Date(Date.now() + 60_000), leaseUntil: new Date(Date.now() + 61_000) })).toBeNull();
    expect(counts.starts).toBe(0);
    expect((await taskStore.find('stale-receipt'))?.state).toEqual(snapshot);
  });

  it('drives a submitted job to completion through the jobs API', async () => {
    const jobRepository = createMemoryJobRepository();
    const { provider, counts } = createScriptedProvider({
      jobRepository,
      script: [{ kind: 'pending' }, { kind: 'completed' }],
    });
    const taskStore = createMemoryPptaskTaskStore();
    const schedulingStages: string[] = [];
    const worker = track(createPptaskWorker({
      ...baseOptions(taskStore, jobRepository, provider),
      reporter: (event) => schedulingStages.push(event.stage),
    }));

    const submit = imageSubmit('req-1', { prompt: 'hi' });
    submit.context = { tenantId: 't1' };
    submit.ownerId = 'u1';
    const { record, created } = await worker.submit(submit);
    expect(created).toBe(true);
    expect(record.status).toBe('submitting');
    expect(record.context).toEqual({ tenantId: 't1' });
    expect(record.ownerId).toBe('u1');

    const task = await waitFor(async () => {
      const current = await taskStore.find('req-1');
      return current?.status === 'completed' ? current : null;
    });
    expect(task.attempt).toBe(1);
    expect(counts.starts).toBe(1);
    // The job snapshot (operation) was synced into the task store.
    expect((task.state as { record?: PptaskJobRecord }).record?.operation).toEqual({ id: 'op-1' });
    expect(schedulingStages).toEqual(['enqueued', 'claimed', 'task-completed']);
  });

  it('deduplicates submissions with the same key', async () => {
    const jobRepository = createMemoryJobRepository();
    const { provider, counts } = createScriptedProvider({
      jobRepository,
      script: [{ kind: 'pending' }, { kind: 'completed' }],
    });
    const taskStore = createMemoryPptaskTaskStore();
    const worker = track(createPptaskWorker(baseOptions(taskStore, jobRepository, provider)));

    const first = await worker.submit(imageSubmit('req-1', { prompt: 'first' }));
    const second = await worker.submit(imageSubmit('req-1', { prompt: 'duplicate' }));

    expect(second.created).toBe(false);
    expect(second.record.key).toBe(first.record.key);
    await waitFor(async () => {
      const current = await taskStore.find('req-1');
      return current?.status === 'completed' ? current : null;
    });
    expect(counts.starts).toBe(1);
  });

  it('recovers the crash window: a submitting task re-creates the job', async () => {
    const jobRepository = createMemoryJobRepository();
    const { provider, counts } = createScriptedProvider({
      jobRepository,
      script: [{ kind: 'completed' }],
    });
    const taskStore = createMemoryPptaskTaskStore();
    // Simulate: the task was durably claimed but the process died before
    // jobs.start ran. Seed the store directly, then let the worker drive.
    await taskStore.submit({
      key: 'req-crash', providerId: 'fake',
      params: { modelType: 'image', modelId: 'demo', input: { prompt: 'crash' } },
      now: new Date(),
    });
    const worker = track(createPptaskWorker(baseOptions(taskStore, jobRepository, provider)));

    const task = await waitFor(async () => {
      const current = await taskStore.find('req-crash');
      return current?.status === 'completed' ? current : null;
    });
    expect(counts.starts).toBe(1);
    const job = await jobRepository.get(((task.state as { jobId?: string }).jobId)!);
    expect(job?.state).toBe('succeeded');
  });

  it('rehydrates a job record snapshot instead of re-running doStart', async () => {
    const jobRepository = createMemoryJobRepository();
    const { provider, counts } = createScriptedProvider({
      jobRepository,
      script: [{ kind: 'completed' }],
    });
    const taskStore = createMemoryPptaskTaskStore();
    const now = new Date().toISOString();
    const snapshot: PptaskJobRecord = {
      schemaVersion: 1,
      id: 'job-rehydrate',
      providerId: 'fake',
      modelType: 'image',
      modelId: 'demo',
      state: 'pending',
      input: { prompt: 'rehydrate' },
      operation: { id: 'op-rehydrate' },
      createdAt: now,
      updatedAt: now,
    };
    await taskStore.submit({
      key: 'req-rehydrate', providerId: 'fake',
      params: { modelType: 'image', modelId: 'demo', input: { prompt: 'rehydrate' } },
      state: { jobId: snapshot.id, record: snapshot },
      now: new Date(),
    });
    const worker = track(createPptaskWorker(baseOptions(taskStore, jobRepository, provider)));

    const task = await waitFor(async () => {
      const current = await taskStore.find('req-rehydrate');
      return current?.status === 'completed' ? current : null;
    });
    // The operation was rehydrated: doStart never ran in this process.
    expect(counts.starts).toBe(0);
    const job = await jobRepository.get('job-rehydrate');
    expect(job?.operation).toEqual({ id: 'op-rehydrate' });
    expect(job?.state).toBe('succeeded');
  });

  it('reschedules transient polling errors with backoff', async () => {
    const jobRepository = createMemoryJobRepository();
    const { provider } = createScriptedProvider({
      jobRepository,
      script: [
        { kind: 'throw', message: 'request timeout' },
        { kind: 'throw', message: 'request timeout' },
        { kind: 'throw', message: 'request timeout' },
        { kind: 'throw', message: 'request timeout' },
        { kind: 'completed' },
      ],
    });
    const taskStore = createMemoryPptaskTaskStore();
    const worker = track(createPptaskWorker(baseOptions(taskStore, jobRepository, provider)));

    await worker.submit(imageSubmit('req-1'));

    // First drive exhausts core's maxStatusErrors (4 errors) and is rescheduled.
    const rescheduled = await waitFor(async () => {
      const current = await taskStore.find('req-1');
      return current?.status === 'queued' && current.nextRunAt ? current : null;
    });
    expect(rescheduled.consecutiveFailures).toBe(1);
    expect(rescheduled.nextRunAt!.getTime()).toBeGreaterThan(Date.now() - 5);

    const task = await waitFor(async () => {
      const current = await taskStore.find('req-1');
      return current?.status === 'completed' ? current : null;
    });
    expect(task.attempt).toBe(2);
    const job = await jobRepository.get(((task.state as { jobId?: string }).jobId)!);
    expect(job?.state).toBe('succeeded');
  });

  it('un-fails provider-declared failures and retries within the budget', async () => {
    const jobRepository = createMemoryJobRepository();
    const { provider, counts } = createScriptedProvider({
      jobRepository,
      script: [
        { kind: 'error', message: 'provider 任务失败：HTTP 503' },
        { kind: 'error', message: 'provider 任务失败：HTTP 503' },
        { kind: 'error', message: 'provider 任务失败：HTTP 503' },
        { kind: 'error', message: 'provider 任务失败：HTTP 503' },
        { kind: 'completed' },
      ],
    });
    const taskStore = createMemoryPptaskTaskStore();
    const schedulingStages: string[] = [];
    const worker = track(createPptaskWorker({
      ...baseOptions(taskStore, jobRepository, provider),
      reporter: (event) => schedulingStages.push(event.stage),
    }));

    await worker.submit(imageSubmit('req-1'));

    const task = await waitFor(async () => {
      const current = await taskStore.find('req-1');
      return current?.status === 'completed' ? current : null;
    });
    expect(task.attempt).toBe(5);
    expect(schedulingStages).toEqual([
      'enqueued', 'claimed',
      'unfail-retry', 'claimed',
      'unfail-retry', 'claimed',
      'unfail-retry', 'claimed',
      'unfail-retry', 'claimed',
      'task-completed',
    ]);
    const job = await jobRepository.get(((task.state as { jobId?: string }).jobId)!);
    expect(job?.state).toBe('succeeded');
    expect(job?.error).toBeUndefined();
  });

  it('fails after the retry budget is exhausted', async () => {
    const jobRepository = createMemoryJobRepository();
    const { provider } = createScriptedProvider({
      jobRepository,
      script: [{ kind: 'error', message: 'provider 任务失败：HTTP 503' }],
    });
    const taskStore = createMemoryPptaskTaskStore();
    const worker = track(createPptaskWorker({
      ...baseOptions(taskStore, jobRepository, provider),
      retryLimit: 3,
    }));

    await worker.submit(imageSubmit('req-1'));

    const task = await waitFor(async () => {
      const current = await taskStore.find('req-1');
      return current?.status === 'failed' ? current : null;
    });
    expect(task.attempt).toBe(3);
    expect(task.consecutiveFailures).toBe(3);

    // No more claims after the terminal failure.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect((await taskStore.find('req-1'))?.attempt).toBe(3);
    const job = await jobRepository.get(((task.state as { jobId?: string }).jobId)!);
    expect(job?.state).toBe('failed');
    expect(job?.error?.message).toContain('HTTP 503');
  });

  it('cancels durably while a drive is running', async () => {
    const jobRepository = createMemoryJobRepository();
    const { provider, counts } = createScriptedProvider({
      jobRepository,
      script: [{ kind: 'pending' }],
    });
    const taskStore = createMemoryPptaskTaskStore();
    const worker = track(createPptaskWorker(baseOptions(taskStore, jobRepository, provider)));

    await worker.submit(imageSubmit('req-1'));
    await waitFor(async () => {
      const current = await taskStore.find('req-1');
      return current?.status === 'executing' && current.state ? current : null;
    });

    await worker.cancel('req-1');

    const task = await waitFor(async () => {
      const current = await taskStore.find('req-1');
      return current?.status === 'cancelled' ? current : null;
    });
    expect(task.attempt).toBe(1);
    expect(counts.cancels).toBe(1);
    const job = await jobRepository.get(((task.state as { jobId?: string }).jobId)!);
    // Core's jobs.cancel is awaited inside worker.cancel before it returns.
    if (job?.state !== 'cancelled') throw new Error(`expected cancelled job, got ${job?.state}`);
  });

  it('fails immediately on a non-retryable provider failure', async () => {
    const jobRepository = createMemoryJobRepository();
    const { provider } = createScriptedProvider({
      jobRepository,
      script: [{ kind: 'error', message: 'invalid prompt rejected by provider' }],
    });
    const taskStore = createMemoryPptaskTaskStore();
    const worker = track(createPptaskWorker(baseOptions(taskStore, jobRepository, provider)));

    await worker.submit(imageSubmit('req-1'));

    const task = await waitFor(async () => {
      const current = await taskStore.find('req-1');
      return current?.status === 'failed' ? current : null;
    });
    expect(task.attempt).toBe(1);
    const job = await jobRepository.get(((task.state as { jobId?: string }).jobId)!);
    expect(job?.state).toBe('failed');
    expect(job?.error?.message).toContain('invalid prompt');
  });

  it('fails the task when the provider cannot be resolved', async () => {
    const jobRepository = createMemoryJobRepository();
    const { provider } = createScriptedProvider({ jobRepository, script: [{ kind: 'completed' }] });
    const taskStore = createMemoryPptaskTaskStore();
    const worker = track(createPptaskWorker({
      ...baseOptions(taskStore, jobRepository, provider),
      resolveProvider: () => undefined,
    }));

    await worker.submit({ ...imageSubmit('req-1'), providerId: 'unknown' });

    const task = await waitFor(async () => {
      const current = await taskStore.find('req-1');
      return current?.status === 'failed' ? current : null;
    });
    expect(task.attempt).toBe(1);
  });

  it('adopts an existing job through the state snapshot', async () => {
    const jobRepository = createMemoryJobRepository();
    const { provider, counts } = createScriptedProvider({
      jobRepository,
      script: [{ kind: 'pending' }, { kind: 'completed' }],
    });
    const taskStore = createMemoryPptaskTaskStore();
    const worker = track(createPptaskWorker(baseOptions(taskStore, jobRepository, provider)));

    // The host created the job bare; submit adopts it into managed scheduling.
    const bare = await provider.jobs.start({
      model: provider.imageModel('adopted'),
      input: { prompt: 'adopt me' },
    });
    const bareRecord = await jobRepository.get(bare.id);
    const { record, created } = await worker.submit({
      key: 'adopt-1', providerId: 'fake',
      modelType: 'image', modelId: 'adopted', input: { prompt: 'adopt me' },
      state: { jobId: bare.id, record: bareRecord! },
    });
    expect(created).toBe(true);
    expect(record.status).toBe('queued');

    const task = await waitFor(async () => {
      const current = await taskStore.find('adopt-1');
      return current?.status === 'completed' ? current : null;
    });
    expect(((task.state as { jobId?: string }).jobId)).toBe(bare.id);
    expect(counts.starts).toBe(1);
  });

  it('drives stream-mode tasks and pushes deltas as execution facts', async () => {
    const jobRepository = createMemoryJobRepository();
    const { provider } = createScriptedProvider({
      jobRepository,
      script: [],
      streamText: '你好，世界',
    });
    const taskStore = createMemoryPptaskTaskStore();
    const deltas: string[] = [];
    const off = subscribePptaskExecutions((event) => {
      const detail = event.detail as { phase?: string; text?: string } | undefined;
      if (event.type === 'progress' && detail?.phase === 'delta' && event.executionId === 'req-stream') {
        deltas.push(detail!.text!);
      }
    });

    const worker = track(createPptaskWorker(baseOptions(taskStore, jobRepository, provider)));

    await worker.submit({
      key: 'req-stream', providerId: 'fake',
      modelType: 'language', modelId: 'chat',
      input: { prompt: 'hi' }, stream: true,
    });

    const task = await waitFor(async () => {
      const current = await taskStore.find('req-stream');
      return current?.status === 'completed' ? current : null;
    });
    expect(task.result).toEqual({ text: '你好' });
    expect((task.state as { text?: string }).text).toBe('你好');
    expect(deltas.join('')).toBe('你好');

    off();
  });

  it('fails stream-mode tasks when the model is not a language model', async () => {
    const jobRepository = createMemoryJobRepository();
    const { provider } = createScriptedProvider({ jobRepository, script: [] });
    const taskStore = createMemoryPptaskTaskStore();
    const worker = track(createPptaskWorker(baseOptions(taskStore, jobRepository, provider)));

    await worker.submit({ ...imageSubmit('req-1'), stream: true });

    const task = await waitFor(async () => {
      const current = await taskStore.find('req-1');
      return current?.status === 'failed' ? current : null;
    });
    expect(task.attempt).toBe(1);
  });

  it('lets a second worker take over after the lease expires', async () => {
    const jobRepository = createMemoryJobRepository();
    // Mutable script: the job stays pending until the takeover is asserted.
    const script: ScriptedOutcome[] = [{ kind: 'pending' }];
    const { provider } = createScriptedProvider({ jobRepository, script });
    const taskStore = createMemoryPptaskTaskStore();
    let currentMs = 1_700_000_000_000;
    const clocked = (taskStoreRef: typeof taskStore, jobRepositoryRef: PptaskJobRepository, providerRef: PptaskProvider) => ({
      taskStore: taskStoreRef,
      jobRepository: jobRepositoryRef,
      resolveProvider: (id: string | undefined) => (id === 'fake' ? providerRef : undefined),
      leaseMs: 200,
      now: () => new Date(currentMs),
    });

    const workerA = track(createPptaskWorker(clocked(taskStore, jobRepository, provider)));
    await workerA.submit(imageSubmit('req-1'));
    await waitFor(async () => {
      const current = await taskStore.find('req-1');
      return current?.status === 'executing' ? current : null;
    });

    // Worker A stalls on the pending script (its drive keeps polling forever).
    // Stop its claim loop, advance past its lease, and let worker B take over.
    workerA.stop();
    currentMs += 300;
    const workerB = track(createPptaskWorker(clocked(taskStore, jobRepository, provider)));
    const takenOver = await waitFor(async () => {
      const current = await taskStore.find('req-1');
      return current?.attempt === 2 && current.status === 'executing' ? current : null;
    });
    expect(takenOver.claimToken).toBeTruthy();

    // Release the job; worker B's drive settles it (worker A is fenced out).
    script.push({ kind: 'completed' });
    const task = await waitFor(async () => {
      const current = await taskStore.find('req-1');
      return current?.status === 'completed' ? current : null;
    });
    expect(task.attempt).toBeGreaterThanOrEqual(2);
    const job = await jobRepository.get(((task.state as { jobId?: string }).jobId)!);
    expect(job?.state).toBe('succeeded');
  });

  it('drained() resolves after in-flight drives finish', async () => {
    const jobRepository = createMemoryJobRepository();
    const script: ScriptedOutcome[] = [{ kind: 'pending' }];
    const { provider } = createScriptedProvider({ jobRepository, script });
    const taskStore = createMemoryPptaskTaskStore();
    const worker = track(createPptaskWorker(baseOptions(taskStore, jobRepository, provider)));

    await worker.submit(imageSubmit('req-1'));
    await waitFor(async () => {
      const current = await taskStore.find('req-1');
      return current?.status === 'executing' ? current : null;
    });

    worker.stop();
    // The in-flight drive finishes the job even though the dispatcher stopped.
    script.push({ kind: 'completed' });
    await worker.drained();
    expect((await taskStore.find('req-1'))?.status).toBe('completed');
  });
});
