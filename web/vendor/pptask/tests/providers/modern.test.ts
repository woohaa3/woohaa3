import { describe, expect, it, vi } from 'vitest';
import { createTavusProvider, listModernCatalog } from '../../src/index.ts';

describe('modern provider protocols', () => {
  it('runs an asynchronous Tavus video', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => String(input).endsWith('/v2/videos')
      ? Response.json({ video_id: 'video-1' })
      : Response.json({ status: 'completed', download_url: 'https://files.test/video.mp4' }));
    const provider = createTavusProvider({ apiKey: 'key', fetch: fetchMock as typeof fetch, pollIntervalMs: 1 });
    const result = await (await provider.jobs.start<any>({ model: provider.videoModel('replica'), input: { prompt: 'hello', n: 1, providerOptions: {} } })).wait();
    expect(result.videos[0].url).toBe('https://files.test/video.mp4');
  });
  it('normalizes a catalog', async () => {
    const fetchMock = vi.fn(async () => Response.json({ items: [{ id: 'voice-1', description: 'demo' }] }));
    await expect(listModernCatalog('fish', { apiKey: 'key', fetch: fetchMock as typeof fetch })).resolves.toMatchObject([{ id: 'voice-1', description: 'demo' }]);
  });
});
