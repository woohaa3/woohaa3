import { describe, expect, it, vi } from 'vitest';
import { uploadFile } from 'ai';
import { createGrsaiProvider } from '../../src/index.ts';

describe('createGrsaiProvider lifecycle', () => {
  it('reads the task id from the first SSE event', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/nano-banana')) return new Response('data: {"code":0,"data":{"id":"gr-1","status":"pending"}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
      if (url.endsWith('/result')) return Response.json({ code: 0, data: { status: 'succeeded', results: [{ url: 'https://files.test/gr.png' }] } });
      if (url === 'https://files.test/gr.png') return new Response(new Uint8Array([6]));
      throw new Error(url);
    });
    const provider = createGrsaiProvider({ apiKey: 'key', baseURL: 'https://gr.test', fetch: fetchMock as typeof fetch, pollIntervalMs: 1 });
    const result = await (await provider.jobs.start<any>({ model: provider.imageModel('nano-banana-fast'), input: { prompt: 'hello', n: 1, providerOptions: {} } })).wait();
    expect(result.images[0]).toEqual(new Uint8Array([6]));
  });

  it('uploads through token and object-storage requests', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ code: 0, data: { url: 'https://upload.test', token: 'token', key: 'folder/a.png', domain: 'https://cdn.test' } }))
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    const provider = createGrsaiProvider({ apiKey: 'key', baseURL: 'https://gr.test', fetch: fetchMock as unknown as typeof fetch });
    const result = await uploadFile({ api: provider, data: new Uint8Array([1]), filename: 'a.png', mediaType: 'image/png' });
    expect(result.providerReference).toEqual({ grsai: 'https://cdn.test/folder/a.png' });
  });
});
