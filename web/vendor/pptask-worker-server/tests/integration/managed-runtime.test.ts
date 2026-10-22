import { afterEach, describe, expect, it } from 'vitest';
import type {
  ImageModelV4Result,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from '@ai-sdk/provider';
import {
  createMemoryJobRepository,
  createPptaskProvider,
  type PptaskJobRecord,
  type PptaskJobRepository,
  type PptaskProvider,
} from '@sdppp/pptask';
import { createMemoryPptaskStorage } from '../../src/storage/index.js';
import { createPptaskWorkerServer, type PptaskWorkerServer } from '../../src/server.js';

type PollOutcome = { kind: 'pending' } | { kind: 'completed' };

type Harness = {
  storage: ReturnType<typeof createMemoryPptaskStorage>;
  jobRepository: PptaskJobRepository;
  provider: PptaskProvider;
  counts: { starts: number; cancels: number };
};

/**
 * Full-stack harness: the real worker, the real history projection and the
 * real storage composition over in-memory backends. Every test drives tasks
 * through `createPptaskWorkerServer` — the same entry a host application uses.
 */
function createHarness(
  options: { script?: PollOutcome[]; streamText?: string } = {},
): Harness {
  const storage = createMemoryPptaskStorage();
  const jobRepository = createMemoryJobRepository();
  const counts = { starts: 0, cancels: 0 };
  const script = [...(options.script ?? [{ kind: 'completed' }])];
  let index = 0;

  const provider: PptaskProvider = createPptaskProvider({
    providerId: 'fake',
    jobRepository,
    pollIntervalMs: 1,
    imageModel: (modelId) => ({
      maxImagesPerCall: 1,
      async doStart() {
        counts.starts += 1;
        return { operation: { id: `op-${counts.starts}` } };
      },
      async doStatus(): Promise<any> {
        // The last outcome repeats, so a lone `pending` stalls the drive.
        const outcome = script[Math.min(index, script.length - 1)];
        index += 1;
        if (outcome.kind === 'pending') {
          return { status: 'pending', phase: 'running', progress: 0.5 };
        }
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
        const text = options.streamText ?? '你好，世界';
        const id = 't1';
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id });
            for (const delta of text.split('')) {
              controller.enqueue({ type: 'text-delta', id, delta });
            }
            controller.enqueue({ type: 'text-end', id });
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop' as const, raw: 'stop' },
              usage: {
                inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: text.length, text: text.length, reasoning: undefined },
              },
            });
            controller.close();
          },
        });
        return { stream };
      },
      async doGenerate(): Promise<LanguageModelV4GenerateResult> {
        const text = options.streamText ?? '答';
        return {
          content: [{ type: 'text' as const, text }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: text.length, text: text.length, reasoning: undefined },
          },
          warnings: [],
          response: { timestamp: new Date(), modelId, headers: undefined },
        };
      },
    }),
  });

  return { storage, jobRepository, provider, counts };
}

const servers: PptaskWorkerServer[] = [];

async function openServer(h: Harness): Promise<PptaskWorkerServer> {
  const server = await createPptaskWorkerServer({
    taskStore: h.storage.taskStore,
    jobRepository: h.jobRepository,
    resolveProvider: async (providerId) => (providerId === 'fake' ? h.provider : undefined),
    historyRepository: h.storage.history('pptask'),
    retryBaseMs: 10,
  });
  servers.push(server);
  return server;
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

function imageInput(key: string, input: unknown = { prompt: 'hi' }) {
  return { key, providerId: 'fake', modelType: 'image' as const, modelId: 'demo', input };
}

describe('managed runtime integration', () => {
  afterEach(async () => {
    await Promise.allSettled(servers.map((server) => server.close()));
    servers.length = 0;
  });

  it('deduplicates concurrent submissions and drives the winner once', async () => {
    const h = createHarness({ script: [{ kind: 'pending' }, { kind: 'completed' }] });
    const server = await openServer(h);

    const input = imageInput('order-1');
    const [first, second] = await Promise.all([server.submit(input), server.submit(input)]);

    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(first.record.key).toBe('order-1');
    expect(second.record.key).toBe('order-1');

    const task = await waitFor(async () => {
      const current = await server.status('order-1');
      return current?.status === 'completed' ? current : null;
    });
    expect(task.attempt).toBe(1);
    expect(h.counts.starts).toBe(1);

    await server.history.flush();
    expect((await server.history.get('order-1'))?.state).toBe('succeeded');
  });

  it('projects one full-flow record: scheduling and execution in a single timeline', async () => {
    const h = createHarness({ script: [{ kind: 'pending' }, { kind: 'completed' }] });
    const server = await openServer(h);
    const updates: string[] = [];
    server.subscribe((record) => updates.push(record.state));

    await server.submit({ ...imageInput('order-2'), context: { tenantId: 't1' } });
    await waitFor(async () => {
      const current = await server.status('order-2');
      return current?.status === 'completed' ? current : null;
    });
    await server.history.flush();

    const record = await server.history.get('order-2');
    expect(record?.state).toBe('succeeded');
    const stages = record!.events.map((event) => `${event.kind}:${event.stage}`);
    expect(stages).toContain('scheduling:worker.enqueued');
    expect(stages).toContain('scheduling:worker.claimed');
    expect(stages).toContain('scheduling:worker.task-completed');
    expect(stages).toContain('execution:pptask.accepted');
    expect(stages).toContain('execution:pptask.succeeded');
    expect(record?.result?.outputs[0]?.kind).toBe('image');
    expect(updates).toContain('succeeded');
  });

  it('rehydrates a persisted job snapshot instead of re-running doStart', async () => {
    const h = createHarness({ script: [{ kind: 'completed' }] });
    const at = new Date().toISOString();
    const snapshot: PptaskJobRecord = {
      schemaVersion: 1,
      id: 'job-rehydrate',
      providerId: 'fake',
      modelType: 'image',
      modelId: 'demo',
      state: 'pending',
      input: { prompt: 'rehydrate' },
      operation: { id: 'op-rehydrate' },
      createdAt: at,
      updatedAt: at,
    };
    // Simulate a crash: the task store holds the accepted operation, the
    // process-local job repository is empty again.
    await h.storage.taskStore.submit({
      key: 'order-3',
      providerId: 'fake',
      params: { modelType: 'image', modelId: 'demo', input: { prompt: 'rehydrate' } },
      state: { jobId: snapshot.id, record: snapshot },
      now: new Date(),
    });

    const server = await openServer(h);
    await waitFor(async () => {
      const current = await server.status('order-3');
      return current?.status === 'completed' ? current : null;
    });

    expect(h.counts.starts).toBe(0);
    const job = await h.jobRepository.get('job-rehydrate');
    expect(job?.operation).toEqual({ id: 'op-rehydrate' });
    expect(job?.state).toBe('succeeded');
    await server.history.flush();
    expect((await server.history.get('order-3'))?.state).toBe('succeeded');
  });

  it('cancels a running task and settles both the record and the history', async () => {
    const h = createHarness({ script: [{ kind: 'pending' }] });
    const server = await openServer(h);

    await server.submit(imageInput('order-4'));
    await waitFor(async () => {
      const current = await server.status('order-4');
      return current?.status === 'executing' && current.state ? current : null;
    });

    await server.cancel('order-4');

    await waitFor(async () => {
      const current = await server.status('order-4');
      return current?.status === 'cancelled' ? current : null;
    });
    expect(h.counts.cancels).toBe(1);
    await server.history.flush();
    expect((await server.history.get('order-4'))?.state).toBe('cancelled');
  });

  it('accumulates stream deltas into the projected record without flooding events', async () => {
    const h = createHarness({ streamText: '你好，世界' });
    const server = await openServer(h);

    await server.submit({
      key: 'chat-5',
      providerId: 'fake',
      modelType: 'language',
      modelId: 'chat',
      input: { prompt: '讲个故事' },
      stream: true,
      context: { tenantId: 't1' },
    });

    const task = await waitFor(async () => {
      const current = await server.status('chat-5');
      return current?.status === 'completed' ? current : null;
    });
    expect(task.result).toEqual({ text: '你好，世界' });
    expect((task.state as { text?: string }).text).toBe('你好，世界');

    await server.history.flush();
    const record = await server.history.get('chat-5');
    expect(record?.state).toBe('succeeded');
    expect(record?.streamedText).toBe('你好，世界');
    expect(record!.events.some((event) => event.stage.includes('stream-started'))).toBe(true);
    expect(record!.events.filter((event) => event.stage.includes('delta'))).toHaveLength(0);
  });
});
