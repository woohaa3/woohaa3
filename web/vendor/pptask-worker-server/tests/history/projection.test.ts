import { describe, expect, it } from 'vitest';
import { generateImage, generateText, streamText } from 'ai';
import { createPptaskProvider, reportPptaskExecution, type PptaskSchedulingEvent } from '@sdppp/pptask';
import {
  createMemoryExecutionHistoryRepository,
  createPptaskExecutionHistory,
  extractExecutionResult,
  type ExecutionRecord,
} from '../../src/history/projection.js';

function createProvider() {
  let statuses = 0;
  return createPptaskProvider({
    providerId: 'history-test',
    pollIntervalMs: 1,
    imageModel: modelId => ({
      maxImagesPerCall: 1,
      async doStart() { return { operation: { id: 'remote-history-task' } }; },
      async doStatus() {
        statuses += 1;
        if (statuses === 1) return { status: 'pending' as const, phase: 'running' as const, progress: 0.5 };
        return {
          status: 'completed' as const,
          images: [new Uint8Array([1, 2, 3])],
          warnings: [],
          response: { timestamp: new Date(), modelId, headers: undefined },
        };
      },
    }),
  });
}

describe('Pptask execution history', () => {
  it('projects execution events emitted by the durable jobs API', async () => {
    const provider = createProvider();
    const history = await createPptaskExecutionHistory();
    const updates: string[] = [];
    history.subscribe(record => updates.push(record.state));
    const job = await provider.jobs.start({
      model: provider.imageModel('demo'),
      input: { prompt: 'hello' },
      metadata: { source: 'test' },
    });
    await job.wait();

    await history.flush();
    const record = (await history.get(job.id))!;
    expect(record.state).toBe('succeeded');
    expect(record.jobId).toBe(job.id);
    expect(record.metadata).toEqual({ source: 'test' });
    expect(record.taskId).toBe('remote-history-task');
    expect(record.result?.outputs[0]).toMatchObject({ kind: 'image', text: '[binary 3 bytes]' });
    expect(record.events.map(event => event.stage)).toEqual(expect.arrayContaining([
      'pptask.created', 'pptask.submitting', 'pptask.accepted', 'pptask.progress', 'pptask.succeeded',
    ]));
    expect(updates).toContain('succeeded');
    await history.dispose();
  });

  it('records a direct AI SDK image call', async () => {
    const provider = createProvider();
    const history = await createPptaskExecutionHistory();

    await generateImage({ model: provider.imageModel('direct-ai-sdk'), prompt: 'hello' });

    await history.flush();
    const records = await history.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      providerId: 'history-test',
      modelId: 'direct-ai-sdk',
      state: 'succeeded',
      jobId: undefined,
    });
    expect(records[0].events.map(event => event.stage)).toEqual([
      'pptask.started', 'pptask.progress', 'pptask.progress', 'pptask.succeeded',
    ]);
    expect(records[0].result?.outputs[0]).toMatchObject({ kind: 'image', text: '[binary 3 bytes]' });
    await history.dispose();
  });

  it('records direct AI SDK text and stream calls', async () => {
    const provider = createPptaskProvider({
      providerId: 'history-direct-text',
      languageModel: modelId => ({
        supportedUrls: {},
        async doGenerate() {
          return {
            content: [{ type: 'text' as const, text: 'direct answer' }],
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: {
              inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 2, text: 2, reasoning: undefined },
            },
            warnings: [],
            response: { timestamp: new Date(), modelId, headers: undefined },
          };
        },
      }),
    });
    const history = await createPptaskExecutionHistory();

    const text = await generateText({ model: provider.languageModel('direct-text'), prompt: 'hello', maxRetries: 0 });
    expect(text.text).toBe('direct answer');
    const stream = streamText({ model: provider.languageModel('direct-stream'), prompt: 'hello', maxRetries: 0 });
    expect(await stream.text).toBe('direct answer');

    await history.flush();
    const records = await history.list();
    expect(records).toHaveLength(2);
    expect(records.every(record => record.state === 'succeeded')).toBe(true);
    expect(records[1].result?.outputs).toEqual([
      { kind: 'text', label: '文本 1', text: 'direct answer' },
    ]);
    await history.dispose();
  });

  it('observes providers created after history initialization', async () => {
    const history = await createPptaskExecutionHistory();
    const provider = createProvider();
    await generateImage({ model: provider.imageModel('late'), prompt: 'hello' });
    await history.flush();
    const records = await history.list();
    expect(records).toHaveLength(1);
    expect(records[0].state).toBe('succeeded');
    await history.dispose();
  });

  it('reloads an event projection from an injected repository', async () => {
    const repository = createMemoryExecutionHistoryRepository<ExecutionRecord>();
    const provider = createProvider();
    const first = await createPptaskExecutionHistory({ repository });
    await generateImage({ model: provider.imageModel('persisted'), prompt: 'hello' });
    await first.flush();
    await first.dispose();

    const second = await createPptaskExecutionHistory({ repository });
    expect(await second.list()).toMatchObject([{ modelId: 'persisted', state: 'succeeded' }]);
    await second.dispose();
  });

  it('extracts media and safely displays binary result values', () => {
    expect(extractExecutionResult({ outputs: [{ data: new Uint8Array([1]) }] }).outputs[0]).toMatchObject({
      kind: 'data',
      text: '[binary 1 bytes]',
    });
  });

  it('surfaces audio outputs instead of dropping them', () => {
    const result = extractExecutionResult({
      audio: 'AQID',
      audios: [{ type: 'base64', data: 'AQID', mediaType: 'audio/mpeg' }],
      warnings: [],
    });

    expect(result.outputCount).toBe(1);
    expect(result.outputs[0]).toMatchObject({ kind: 'audio', mediaType: 'audio/mpeg' });
  });

  it('surfaces raw and url audio outputs', () => {
    expect(extractExecutionResult({ audio: new Uint8Array([1, 2, 3]) }).outputs[0]).toMatchObject({
      kind: 'audio',
      text: '[binary 3 bytes]',
    });
    expect(extractExecutionResult({ audio: 'https://cdn.test/a.mp3' }).outputs[0]).toMatchObject({
      kind: 'audio',
      url: 'https://cdn.test/a.mp3',
    });
  });

  it('extracts text and tool calls from an AI SDK result', async () => {
    const provider = createPptaskProvider({
      providerId: 'history-llm',
      languageModel: modelId => ({
        supportedUrls: {},
        async doGenerate() {
          return {
            content: [
              { type: 'text' as const, text: '回答内容' },
              { type: 'tool-call' as const, toolCallId: 'call-1', toolName: 'lookup', input: '{"q":"x"}' },
            ],
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: {
              inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 2, text: 2, reasoning: undefined },
            },
            warnings: [],
            response: { timestamp: new Date(), modelId, headers: undefined },
          };
        },
      }),
    });
    const history = await createPptaskExecutionHistory();
    await generateText({ model: provider.languageModel('llm'), prompt: 'hello' });

    await history.flush();
    expect((await history.list())[0].result?.outputs).toEqual([
      { kind: 'text', label: '文本 1', text: '回答内容' },
      { kind: 'data', label: 'tool-call 2', text: expect.stringContaining('lookup') },
    ]);
    await history.dispose();
  });

  it('merges scheduling and execution phases into one full-flow timeline', async () => {
    const history = await createPptaskExecutionHistory();
    const schedule = (stage: PptaskSchedulingEvent['stage'], overrides: Partial<PptaskSchedulingEvent> = {}) => {
      history.ingestSchedulingEvent({
        stage,
        jobId: 'job-flow',
        providerId: 'fake',
        at: new Date(Date.now()).toISOString(),
        ...overrides,
      });
    };

    // Scheduling facts arrive before any job event: the record starts queued.
    schedule('enqueued', { detail: { created: true } });
    expect(await history.get('job-flow')).toMatchObject({
      state: 'queued',
      providerId: 'fake',
      modelType: undefined,
    });

    // Execution facts fill in the model and move the state forward.
    reportPptaskExecution({
      type: 'created', executionId: 'job-flow', jobId: 'job-flow', providerId: 'fake',
      modelType: 'image', modelId: 'demo', at: new Date().toISOString(), state: 'creating',
    });
    schedule('claimed', { attempt: 1 });
    reportPptaskExecution({
      type: 'progress', executionId: 'job-flow', jobId: 'job-flow', providerId: 'fake',
      modelType: 'image', modelId: 'demo', at: new Date().toISOString(), state: 'pending', progress: 0.5,
    });
    schedule('unfail-retry', { attempt: 2, consecutiveFailures: 1, detail: { nextRunAt: 'later' } });
    reportPptaskExecution({
      type: 'succeeded', executionId: 'job-flow', jobId: 'job-flow', providerId: 'fake',
      modelType: 'image', modelId: 'demo', at: new Date().toISOString(), state: 'succeeded',
      result: { outputs: [{ kind: 'text', text: 'done' }] },
    });
    schedule('task-completed', { attempt: 2 });

    await history.flush();
    const record = (await history.get('job-flow'))!;
    expect(record.state).toBe('succeeded');
    expect(record.modelType).toBe('image');
    expect(record.modelId).toBe('demo');
    expect(record.attempt).toBe(2);
    expect(record.consecutiveFailures).toBe(1);
    expect(record.finishedAt).toBeTruthy();
    const stages = record.events.map((event) => `${event.kind}:${event.stage}`);
    expect(stages).toEqual([
      'scheduling:worker.enqueued',
      'execution:pptask.created',
      'scheduling:worker.claimed',
      'execution:pptask.progress',
      'scheduling:worker.unfail-retry',
      'execution:pptask.succeeded',
      'scheduling:worker.task-completed',
    ]);
    await history.dispose();
  });

  it('settles a scheduling-only failure without execution events', async () => {
    const history = await createPptaskExecutionHistory();
    history.ingestSchedulingEvent({
      stage: 'enqueued', jobId: 'job-orphan', providerId: 'fake',
      at: new Date().toISOString(),
    });
    history.ingestSchedulingEvent({
      stage: 'claimed', jobId: 'job-orphan', providerId: 'fake',
      attempt: 1, at: new Date().toISOString(),
    });
    history.ingestSchedulingEvent({
      stage: 'task-failed', jobId: 'job-orphan', providerId: 'fake',
      attempt: 1, consecutiveFailures: 5, at: new Date().toISOString(),
    });

    await history.flush();
    expect(await history.get('job-orphan')).toMatchObject({
      state: 'failed',
      attempt: 1,
      consecutiveFailures: 5,
      finishedAt: expect.any(String),
    });
    await history.dispose();
  });
});

describe('stream delta accumulation', () => {
  it('accumulates delta facts into streamedText without flooding events', async () => {
    const history = await createPptaskExecutionHistory();
    const at = new Date().toISOString();
    history.ingestSchedulingEvent({ stage: 'enqueued', jobId: 'chat-9', providerId: 'fake', at });
    reportPptaskExecution({
      type: 'started', executionId: 'chat-9', jobId: 'chat-9', providerId: 'fake',
      modelType: 'language', modelId: 'chat', at,
    });
    for (const text of ['你', '好', '，', '世', '界']) {
      reportPptaskExecution({
        type: 'progress', executionId: 'chat-9', jobId: 'chat-9', providerId: 'fake',
        modelType: 'language', modelId: 'chat', at,
        detail: { phase: 'delta', text },
      });
    }
    reportPptaskExecution({
      type: 'succeeded', executionId: 'chat-9', jobId: 'chat-9', providerId: 'fake',
      modelType: 'language', modelId: 'chat', at,
      result: { text: '你好，世界' },
    });

    await history.flush();
    const record = (await history.get('chat-9'))!;
    expect(record.streamedText).toBe('你好，世界');
    expect(record.state).toBe('succeeded');
    expect(record.events.filter((event) => event.stage.includes('delta'))).toHaveLength(0);
    expect(record.events.some((event) => event.stage === 'pptask.started')).toBe(true);
    await history.dispose();
  });
});
