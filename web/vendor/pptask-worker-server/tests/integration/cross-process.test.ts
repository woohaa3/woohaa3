/**
 * Cross-process integration test — PREVIEW, not implemented yet.
 *
 * `createPptaskWorkerServer` is a single-process composition. sdpppx runs the
 * scheduler and the HTTP API in *different* processes, so the runtime has to be
 * split into two roles that share Postgres (taskStore + history repository) and
 * a fact channel (Redis in production):
 *
 *   worker process → createPptaskWorkerRuntime(...)   // claims, drives, projects
 *   API process    → createPptaskServerApi(...)       // submit/status/cancel/history/SSE
 *
 * What already works across processes today: `taskStore` is shared, so
 * dedup-by-key, claiming, lease takeover and crash recovery are process-count
 * agnostic (see the takeover test in worker.test.ts).
 *
 * What this file proposes to add:
 *   - `history` reads go through the repository (read-through), instead of the
 *     projection's construction-time in-memory snapshot;
 *   - execution facts are forwarded over a fact channel, so the API process can
 *     push deltas/status to clients without owning the execution.
 *
 * NOTHING HERE IS IMPLEMENTED. The two factories below are typed stubs that
 * throw, the fact channel is an in-memory test double, and every test is
 * skipped so the integration suite stays green. Read this file as the proposed
 * surface + naming; drop `.skip` (and implement the factories) once the shape
 * is agreed.
 */
import { describe, expect, it } from 'vitest';
import type { LanguageModelV4StreamResult } from '@ai-sdk/provider';
import {
  createMemoryJobRepository,
  createPptaskProvider,
  type PptaskJobRepository,
  type PptaskProvider,
} from '@sdppp/pptask';
import type { ExecutionHistoryRepository, ExecutionRecord } from '../../src/history/index.js';
import { createMemoryPptaskStorage } from '../../src/index.js';
import type {
  PptaskTaskRecord,
  PptaskTaskStore,
  PptaskWorker,
  PptaskWorkerSubmitInput,
  PptaskWorkerSubmitResult,
} from '../../src/index.js';

/* -------------------------------------------------------------------------- *
 * Proposed surface
 * -------------------------------------------------------------------------- */

/** Cross-process carrier of projected records. Redis in production. */
type PptaskFactChannel = {
  publish(record: ExecutionRecord): void;
  /** Delivers records produced by *other* processes. */
  subscribe(listener: (record: ExecutionRecord) => void): () => void;
};

/** Read-through history access: repository first, projection cache second. */
type PptaskHistoryReader = {
  get(id: string): Promise<ExecutionRecord | undefined>;
  list(options?: { cursor?: string; limit?: number }): Promise<{
    records: ExecutionRecord[];
    nextCursor?: string;
  }>;
};

/** Worker-process role: scheduling, driving, history writes, fact publishing. */
type PptaskWorkerRuntimeOptions = {
  taskStore: PptaskTaskStore;
  jobRepository: PptaskJobRepository;
  resolveProvider(
    providerId: string | undefined,
  ): PptaskProvider | undefined | Promise<PptaskProvider | undefined>;
  historyRepository: ExecutionHistoryRepository<ExecutionRecord>;
  facts?: PptaskFactChannel;
  concurrency?: number;
  intervalMs?: number;
  leaseMs?: number;
  retryLimit?: number;
  retryBaseMs?: number;
  now?: () => Date;
  log?: (stage: string, details: Record<string, unknown>) => void;
};

type PptaskWorkerRuntime = {
  worker: PptaskWorker;
  stop(): void;
  drained(): Promise<void>;
  /** stop() + drained() + flush the history projection. */
  close(): Promise<void>;
};

/** API-process role: submission, status, cancel, history reads, SSE feed. */
type PptaskServerApiOptions = {
  taskStore: PptaskTaskStore;
  historyRepository: ExecutionHistoryRepository<ExecutionRecord>;
  facts?: PptaskFactChannel;
  now?: () => Date;
};

type PptaskServerApi = {
  /** Managed entry: atomic dedup on the shared taskStore. */
  submit(input: PptaskWorkerSubmitInput): Promise<PptaskWorkerSubmitResult>;
  status(key: string): Promise<PptaskTaskRecord | null>;
  cancel(key: string): Promise<void>;
  history: PptaskHistoryReader;
  /** Records from this process's own reads plus facts published by workers. */
  subscribe(listener: (record: ExecutionRecord) => void): () => void;
  close(): Promise<void>;
};

function createPptaskWorkerRuntime(_options: PptaskWorkerRuntimeOptions): Promise<PptaskWorkerRuntime> {
  throw new Error('PREVIEW ONLY: createPptaskWorkerRuntime is not implemented yet');
}

function createPptaskServerApi(_options: PptaskServerApiOptions): Promise<PptaskServerApi> {
  throw new Error('PREVIEW ONLY: createPptaskServerApi is not implemented yet');
}

/* -------------------------------------------------------------------------- *
 * Test doubles standing in for infrastructure
 * -------------------------------------------------------------------------- */

/** Stands in for Redis pub/sub (sdpppx already runs `services/pubsub`). */
function createMemoryPptaskFactChannel(): PptaskFactChannel {
  const listeners = new Set<(record: ExecutionRecord) => void>();
  return {
    publish(record) {
      for (const listener of listeners) listener(record);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function createPreviewProvider(jobRepository: PptaskJobRepository): PptaskProvider {
  return createPptaskProvider({
    providerId: 'fake',
    jobRepository,
    pollIntervalMs: 1,
    imageModel: (modelId) => ({
      maxImagesPerCall: 1,
      async doStart() {
        return { operation: { id: 'op-1' } };
      },
      async doStatus() {
        return {
          status: 'completed' as const,
          images: [new Uint8Array([1])],
          warnings: [],
          response: { timestamp: new Date(), modelId, headers: undefined },
        } as any;
      },
      async doCancel() {},
    }),
    languageModel: (modelId) => ({
      supportedUrls: {},
      async doStream(): Promise<LanguageModelV4StreamResult> {
        const id = 't1';
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id });
            for (const delta of ['你', '好']) controller.enqueue({ type: 'text-delta', id, delta });
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
    }),
  });
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

/* -------------------------------------------------------------------------- *
 * Previewed calling pattern
 * -------------------------------------------------------------------------- */

describe.skip('cross-process runtime (preview — not implemented)', () => {
  /** Two hosts, one Postgres + one Redis. */
  async function deploy() {
    const storage = createMemoryPptaskStorage(); // → Postgres-backed storage
    const facts = createMemoryPptaskFactChannel(); // → Redis pub/sub
    const jobRepository = createMemoryJobRepository();
    const provider = createPreviewProvider(jobRepository);

    // --- worker process: claims due tasks, drives them, writes history ---
    const runtime = await createPptaskWorkerRuntime({
      taskStore: storage.taskStore,
      jobRepository,
      resolveProvider: async (providerId) => (providerId === 'fake' ? provider : undefined),
      historyRepository: storage.history('pptask'),
      facts,
      intervalMs: 5,
    });

    // --- API process: accepts requests, reads status/history, pushes SSE ---
    const api = await createPptaskServerApi({
      taskStore: storage.taskStore,
      historyRepository: storage.history('pptask'),
      facts,
    });

    return { storage, facts, jobRepository, provider, runtime, api };
  }

  it('API process submits; worker process drives; API process streams the result', async () => {
    const { runtime, api } = await deploy();

    // The API process subscribes to facts produced by the worker process.
    const seen: string[] = [];
    const unsubscribe = api.subscribe((record) => seen.push(`${record.id}:${record.state}`));

    // Only the API process accepts submissions.
    const { record, created } = await api.submit({
      key: 'chat-42',
      providerId: 'fake',
      modelType: 'language',
      modelId: 'chat',
      input: { prompt: '讲个故事' },
      stream: true,
      context: { tenantId: 't1' },
    });
    expect(created).toBe(true);
    expect(record.status).toBe('submitting');

    // Status is read from the shared taskStore, whichever process claimed it.
    const task = await waitFor(async () => {
      const current = await api.status('chat-42');
      return current?.status === 'completed' ? current : null;
    });
    expect(task.result).toEqual({ text: '你好' });

    // History read-through sees the worker process's projection.
    const projected = await api.history.get('chat-42');
    expect(projected?.state).toBe('succeeded');
    expect(projected?.streamedText).toBe('你好');

    // The SSE feed carried the worker process's facts.
    expect(seen).toContain('chat-42:succeeded');

    unsubscribe();
    await api.close();
    await runtime.close();
  });

  it('API process cancels a task the worker process is driving', async () => {
    const { runtime, api } = await deploy();

    await api.submit({
      key: 'order-1',
      providerId: 'fake',
      modelType: 'image',
      modelId: 'demo',
      input: { prompt: 'hi' },
    });
    await waitFor(async () => {
      const current = await api.status('order-1');
      return current?.status === 'executing' ? current : null;
    });

    // Durable cancel lands on the shared taskStore and reaches the driver
    // through the same fact channel.
    await api.cancel('order-1');

    await waitFor(async () => {
      const current = await api.status('order-1');
      return current?.status === 'cancelled' ? current : null;
    });
    expect((await api.history.get('order-1'))?.state).toBe('cancelled');

    await api.close();
    await runtime.close();
  });

  it('a restarted API process backfills history from the repository', async () => {
    const { storage, facts, runtime, api } = await deploy();

    await api.submit({
      key: 'order-2',
      providerId: 'fake',
      modelType: 'image',
      modelId: 'demo',
      input: { prompt: 'hi' },
    });
    await waitFor(async () => {
      const current = await api.status('order-2');
      return current?.status === 'completed' ? current : null;
    });
    await api.close();

    // A fresh API process has an empty in-process cache: reads must fall
    // through to the repository rather than serve a stale snapshot.
    const restarted = await createPptaskServerApi({
      taskStore: storage.taskStore,
      historyRepository: storage.history('pptask'),
      facts,
    });
    const projected = await restarted.history.get('order-2');
    expect(projected?.state).toBe('succeeded');

    await restarted.close();
    await runtime.close();
  });
});
