import { describe, expect, it, vi } from 'vitest';
import { uploadFile } from 'ai';
import { createKieProvider } from '../../src/index.ts';

describe('createKieProvider lifecycle', () => {
  it('creates, polls, and downloads an image', async () => {
    let polls = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/createTask')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'seedream/5-pro-text-to-image', input: { prompt: 'hello' } });
        return Response.json({ code: 200, data: { taskId: 'kie-1' } });
      }
      if (url.includes('/recordInfo')) {
        polls += 1;
        return Response.json({ code: 200, data: polls === 1 ? { state: 'generating', progress: 40 } : { state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://files.test/kie.png'] }) } });
      }
      if (url === 'https://files.test/kie.png') return new Response(new Uint8Array([1, 2, 3]));
      throw new Error(url);
    });
    const provider = createKieProvider({ apiKey: 'key', fetch: fetchMock as typeof fetch, pollIntervalMs: 1 });
    const job = await provider.jobs.start<any>({ model: provider.imageModel('seedream/5-pro-text-to-image'), input: { prompt: 'hello', n: 1, providerOptions: {} } });
    expect((await job.wait()).images[0]).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('uses the catalog for model validation and describe schemas', async () => {
    const provider = createKieProvider({ apiKey: 'key', fetch: vi.fn() as typeof fetch });
    const description = await provider.describe(provider.imageModel('seedream/5-pro-text-to-image'));
    expect(description.title).toBe('Seedream 5 Pro T2I');
    expect(description.inputSchema).toMatchObject({
      required: ['prompt', 'aspect_ratio', 'quality'],
      properties: { quality: { default: 'basic' } },
    });
    expect(description.defaultInput).toMatchObject({ quality: 'basic', output_format: 'png' });
    expect(() => provider.imageModel('bytedance/seedream')).toThrow('Unsupported Kie model');
    expect(() => provider.imageModel('kling-3.0/video')).toThrow('must be used as a video model');
  });

  it('uploads through FilesV4', async () => {
    const fetchMock = vi.fn(async () => Response.json({ success: true, data: { downloadUrl: 'https://files.test/input.png' } }));
    const provider = createKieProvider({ apiKey: 'key', fetch: fetchMock as typeof fetch });
    const result = await uploadFile({ api: provider, data: new Uint8Array([1]), filename: 'a.png', mediaType: 'image/png' });
    expect(result.providerReference).toEqual({ kie: 'https://files.test/input.png' });
  });
});
