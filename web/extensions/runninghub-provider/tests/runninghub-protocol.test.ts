import { describe, expect, it, vi } from 'vitest';
import { uploadFile } from 'ai';
import { createMemoryJobRepository } from '@sdppp/pptask';
import { createRunninghubProvider } from '../src/provider/index.js';

describe('createRunninghubProvider', () => {
  it('runs an API image model through the durable job interface', async () => {
    let statusCalls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/rhart-image-n-pro/text-to-image')) {
        expect(init?.method).toBe('POST');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key');
        return Response.json({ taskId: 'api-task-1', status: 'PENDING' });
      }
      if (url.endsWith('/query')) {
        statusCalls += 1;
        return Response.json(statusCalls === 1
          ? { taskId: 'api-task-1', status: 'RUNNING' }
          : {
            taskId: 'api-task-1',
            status: 'SUCCESS',
            results: [{ url: 'https://files.test/result.png' }],
          });
      }
      if (url === 'https://files.test/result.png') {
        return new Response(new Uint8Array([4, 5, 6]), {
          headers: { 'content-type': 'image/png' },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const provider = createRunninghubProvider({
      apiKey: 'test-key',
      fetch: fetchMock as typeof fetch,
      jobRepository: createMemoryJobRepository(),
      pollIntervalMs: 1,
    });
    const job = await provider.jobs.start<{ images: Uint8Array[] }>({
      model: provider.imageModel('api/rhart-image-n-pro/text-to-image'),
      input: { prompt: 'hello', providerOptions: {} },
    });

    const result = await job.wait();

    expect(result.images[0]).toEqual(new Uint8Array([4, 5, 6]));
    expect(statusCalls).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('runs an App video model and resumes it without creating twice', async () => {
    let statusCalls = 0;
    let starts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/webapp/apiCallDemo')) {
        return Response.json({
          code: 0,
          data: {
            nodeInfoList: [{ nodeId: 1, fieldName: 'prompt', fieldType: 'text', fieldValue: '' }],
          },
        });
      }
      if (url.endsWith('/task/openapi/ai-app/run')) {
        starts += 1;
        const body = JSON.parse(String(init?.body));
        expect(body.nodeInfoList[0].fieldValue).toBe('make a clip');
        return Response.json({ code: 0, data: { taskId: 'app-task-1' } });
      }
      if (url.endsWith('/task/openapi/status')) {
        statusCalls += 1;
        return Response.json({ code: 0, data: { status: statusCalls === 1 ? 'RUNNING' : 'SUCCESS' } });
      }
      if (url.endsWith('/task/openapi/outputs')) {
        return Response.json({ code: 0, data: [{ fileUrl: 'https://files.test/result.mp4' }] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const store = createMemoryJobRepository();
    const first = createRunninghubProvider({ apiKey: 'test-key', fetch: fetchMock as typeof fetch, jobRepository: store, pollIntervalMs: 1 });
    const started = await first.jobs.start({
      model: first.videoModel('app/webapp-1'),
      input: { prompt: 'make a clip', providerOptions: {} },
    });

    const reloaded = createRunninghubProvider({ apiKey: 'test-key', fetch: fetchMock as typeof fetch, jobRepository: store, pollIntervalMs: 1 });
    const result = await (await reloaded.jobs.resume<{ videos: Array<{ url: string }> }>(started.id)).wait();

    expect(result.videos[0].url).toBe('https://files.test/result.mp4');
    expect(starts).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/task/openapi/ai-app/run'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('supports describe, upload, and cancellation for App models', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/webapp/apiCallDemo')) {
        return Response.json({ code: 0, data: { nodeInfoList: [{ nodeId: 1, fieldName: 'prompt', fieldType: 'text' }] } });
      }
      if (url.endsWith('/task/openapi/upload')) return Response.json({ code: 0, data: { fileName: 'uploaded-file' } });
      if (url.endsWith('/task/openapi/ai-app/run')) return Response.json({ code: 0, data: { taskId: 'cancel-task' } });
      if (url.endsWith('/task/openapi/cancel')) return Response.json({ code: 0 });
      throw new Error(`Unexpected request: ${url}`);
    });
    const provider = createRunninghubProvider({ apiKey: 'test-key', fetch: fetchMock as typeof fetch });

    const description = await provider.describe(provider.imageModel('app/webapp-1'));
    const uploaded = await uploadFile({
      api: provider,
      data: new Uint8Array([1, 2]),
      filename: 'a.png',
      mediaType: 'image/png',
    });
    const job = await provider.jobs.start({
      model: provider.imageModel('app/webapp-1'),
      input: { prompt: 'cancel', providerOptions: {} },
    });
    await job.cancel();

    expect(description.inputSchema?.properties).toHaveProperty('1_prompt');
    expect(uploaded.providerReference).toEqual({ runninghub: 'uploaded-file' });
    expect((await job.status()).state).toBe('cancelled');
  });
});
