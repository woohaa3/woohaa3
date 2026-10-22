import { describe, expect, it, vi } from 'vitest';
import { uploadFile } from 'ai';
import { createComfyProvider } from '../../src/index.ts';

describe('createComfyProvider lifecycle', () => {
  it('uses prompt, history, view, and cancellation endpoints', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/prompt')) return Response.json({ prompt_id: 'comfy-1' });
      if (url.includes('/history/')) return Response.json({ 'comfy-1': { status: { status_str: 'success' }, outputs: { node: { images: [{ filename: 'a.png', type: 'output' }] } } } });
      if (url.includes('/view?')) return new Response(new Uint8Array([7]));
      if (url.endsWith('/interrupt') || url.endsWith('/queue')) return Response.json({});
      throw new Error(url);
    });
    const provider = createComfyProvider({ baseURL: 'https://comfy.test', fetch: fetchMock as typeof fetch, pollIntervalMs: 1 });
    const result = await (await provider.jobs.start<any>({ model: provider.imageModel('workflow'), input: { prompt: { node: {} }, n: 1, providerOptions: {} } })).wait();
    expect(result.images[0]).toEqual(new Uint8Array([7]));
  });

  it('uploads and cancels through ComfyUI endpoints', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/upload/image')) return Response.json({ name: 'input.png' });
      if (url.endsWith('/prompt')) return Response.json({ prompt_id: 'cancel-1' });
      if (url.endsWith('/interrupt') || url.endsWith('/queue')) return Response.json({});
      throw new Error(url);
    });
    const provider = createComfyProvider({ baseURL: 'https://comfy.test', fetch: fetchMock as typeof fetch });
    const uploaded = await uploadFile({ api: provider, data: new Uint8Array([1]), filename: 'a.png', mediaType: 'image/png' });
    const job = await provider.jobs.start({ model: provider.imageModel('workflow'), input: { prompt: {}, n: 1, providerOptions: {} } });
    await job.cancel();
    expect(uploaded.providerReference).toEqual({ comfy: 'input.png' });
    expect((await job.status()).state).toBe('cancelled');
  });
});
