import { describe, expect, it, vi } from 'vitest';
import { uploadFile } from 'ai';
import { createApiframeProvider } from '../../src/index.ts';

describe('createApiframeProvider lifecycle', () => {
  it('uses modality endpoints and nested model parameters', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v2/images/generate')) {
        expect(JSON.parse(String(init?.body))).toEqual({ model: 'flux-2-pro', prompt: 'hello' });
        return Response.json({ jobId: 'api-1' });
      }
      if (url.endsWith('/v2/jobs/api-1')) return Response.json({ status: 'COMPLETED', result: { images: ['https://files.test/a.png'] } });
      if (url === 'https://files.test/a.png') return new Response(new Uint8Array([4]));
      throw new Error(url);
    });
    const provider = createApiframeProvider({ apiKey: 'key', fetch: fetchMock as typeof fetch, pollIntervalMs: 1 });
    const result = await (await provider.jobs.start<any>({ model: provider.imageModel('flux-2-pro'), input: { prompt: 'hello', n: 1, providerOptions: {} } })).wait();
    expect(result.images[0]).toEqual(new Uint8Array([4]));
  });

  it('uses catalog endpoints, nested fields, and flattened describe schemas', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'flux-2-pro',
        prompt: 'hello',
        fluxParams: { guidance: 7.5, aspect_ratio: '16:9' },
      });
      return Response.json({ jobId: 'api-2' });
    });
    const provider = createApiframeProvider({ apiKey: 'key', fetch: fetchMock as typeof fetch });
    const model = provider.imageModel('flux-2-pro');
    await model.doStart!({
      prompt: 'hello', n: 1, size: undefined, aspectRatio: undefined, seed: undefined,
      files: undefined, mask: undefined,
      providerOptions: { apiframe: { guidance: 7.5, aspect_ratio: '16:9', unknown: true } },
    });
    const description = await provider.describe(model);
    expect(description.inputSchema).toMatchObject({
      properties: { guidance: { minimum: 1.5, maximum: 10 }, input_images: { type: 'array' } },
    });
    expect(description.inputSchema).not.toHaveProperty('properties.fluxParams');
    expect(() => provider.imageModel('dall-e-3')).toThrow('Unsupported Apiframe model');
  });

  it('uploads through FilesV4', async () => {
    const provider = createApiframeProvider({ apiKey: 'key', fetch: vi.fn(async () => Response.json({ url: 'https://files.test/input.png' })) as unknown as typeof fetch });
    const result = await uploadFile({ api: provider, data: new Uint8Array([1]), filename: 'a.png', mediaType: 'image/png' });
    expect(result.providerReference).toEqual({ apiframe: 'https://files.test/input.png' });
  });
});
