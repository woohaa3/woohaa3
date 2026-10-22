import { describe, expect, it } from 'vitest';
import type { ImageModelV4Result, LanguageModelV4GenerateResult, LanguageModelV4StreamResult } from '@ai-sdk/provider';
import {
  createMemoryJobRepository,
  createPptaskProvider,
  type PptaskJobRepository,
  type PptaskProvider,
} from '@sdppp/pptask';
import { createMemoryPptaskStorage } from '../src/storage/index.js';
import { createPptaskWorkerServer } from '../src/server.js';

function createHarness() {
  const storage = createMemoryPptaskStorage();
  const jobRepository = createMemoryJobRepository();
  const script: Array<{ kind: 'pending' | 'completed' }> = [];
  let index = 0;
  let streamText = '你好，世界';
  const provider: PptaskProvider = createPptaskProvider({
    providerId: 'fake',
    jobRepository,
    pollIntervalMs: 1,
    imageModel: (modelId) => ({
      maxImagesPerCall: 1,
      async doStart() {
        return { operation: { id: `op-${Date.now()}` } };
      },
      async doStatus(): Promise<any> {
        const outcome = script[Math.min(index, script.length - 1)];
        index += 1;
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
    languageModel: (modelId) => ({
      supportedUrls: {},
      async doStream(): Promise<LanguageModelV4StreamResult> {
        const chunks = ['你', '好', '，', '世', '界'];
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
                outputTokens: { total: 5, text: 5, reasoning: undefined },
              },
            });
            controller.close();
          },
        });
        return { stream };
      },
      async doGenerate(): Promise<LanguageModelV4GenerateResult> {
        return {
          content: [{ type: 'text' as const, text: streamText }],
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
  return {
    storage,
    jobRepository,
    provider,
    script,
    setStreamText(text: string) {
      streamText = text;
    },
  };
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

describe('createPptaskWorkerServer', () => {
  it('composes scheduling and history: one submit produces a full-flow record', async () => {
    const h = createHarness();
    h.script.push({ kind: 'pending' }, { kind: 'completed' });
    const server = await createPptaskWorkerServer({
      taskStore: h.storage.taskStore,
      jobRepository: h.jobRepository,
      resolveProvider: async () => h.provider,
      historyRepository: h.storage.history('pptask'),
    });

    const updates: string[] = [];
    server.subscribe((record) => updates.push(record.state));

    const { record } = await server.submit({
      key: 'req-1',
      providerId: 'fake',
      modelType: 'image',
      modelId: 'demo',
      input: { prompt: 'hi' },
      context: { tenantId: 't1' },
    });
    expect(record.status).toBe('submitting');

    const task = await waitFor(async () => {
      const current = await server.status('req-1');
      return current?.status === 'completed' ? current : null;
    });
    expect(task.result).toBeDefined();
    expect((task.state as { jobId?: string }).jobId).toBeTruthy();

    await server.history.flush();
    const projected = await server.history.get('req-1');
    expect(projected?.state).toBe('succeeded');
    const stages = projected!.events.map((event) => `${event.kind}:${event.stage}`);
    expect(stages).toContain('scheduling:worker.enqueued');
    expect(stages).toContain('scheduling:worker.claimed');
    expect(stages).toContain('scheduling:worker.task-completed');
    expect(stages).toContain('execution:pptask.accepted');
    expect(stages).toContain('execution:pptask.succeeded');
    expect(updates).toContain('succeeded');

    await server.close();
  });

  it('drives stream-mode tasks and accumulates deltas into history', async () => {
    const h = createHarness();
    h.setStreamText('你好，世界');
    const server = await createPptaskWorkerServer({
      taskStore: h.storage.taskStore,
      jobRepository: h.jobRepository,
      resolveProvider: async () => h.provider,
      historyRepository: h.storage.history('pptask'),
    });

    await server.submit({
      key: 'chat-1',
      providerId: 'fake',
      modelType: 'language',
      modelId: 'chat',
      input: { prompt: 'hi' },
      stream: true,
      context: { tenantId: 't1' },
    });

    const task = await waitFor(async () => {
      const current = await server.status('chat-1');
      return current?.status === 'completed' ? current : null;
    });
    expect(task.result).toEqual({ text: '你好，世界' });

    await server.history.flush();
    const projected = await server.history.get('chat-1');
    expect(projected?.state).toBe('succeeded');
    expect(projected?.streamedText).toBe('你好，世界');
    // Deltas do not flood the event log.
    expect(projected!.events.filter((event) => event.stage.includes('delta'))).toHaveLength(0);
    expect(projected!.events.some((event) => event.stage.includes('stream-started'))).toBe(true);

    await server.close();
  });

  it('cancel settles the task and surfaces it through history', async () => {
    const h = createHarness();
    h.script.push({ kind: 'pending' });
    const server = await createPptaskWorkerServer({
      taskStore: h.storage.taskStore,
      jobRepository: h.jobRepository,
      resolveProvider: async () => h.provider,
      historyRepository: h.storage.history('pptask'),
    });

    await server.submit({
      key: 'req-1',
      providerId: 'fake',
      modelType: 'image',
      modelId: 'demo',
      input: { prompt: 'hi' },
    });
    await waitFor(async () => {
      const current = await server.status('req-1');
      return current?.status === 'executing' ? current : null;
    });

    await server.cancel('req-1');

    const task = await waitFor(async () => {
      const current = await server.status('req-1');
      return current?.status === 'cancelled' ? current : null;
    });
    await server.history.flush();
    expect((await server.history.get('req-1'))?.state).toBe('cancelled');

    await server.close();
  });
});
