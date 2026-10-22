import { describe, expect, it, vi } from 'vitest';
import { createGeminiProvider, createOpenAIProvider } from '../../src/index.ts';

const call = (provider: ReturnType<typeof createOpenAIProvider>, modelId: string) => provider.imageModel(modelId).doGenerate!({ prompt: 'hello', n: 1, size: undefined, aspectRatio: undefined, seed: undefined, files: undefined, mask: undefined, providerOptions: {} });

describe('synchronous image providers', () => {
  it('OpenAI', async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: [{ b64_json: 'AQ==' }] }));
    const provider = createOpenAIProvider({ apiKey: 'key', fetch: fetchMock as typeof fetch });
    expect((await call(provider, 'gpt-image-1')).images[0]).toEqual(new Uint8Array([1]));
  });
  it('Gemini', async () => {
    const fetchMock = vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ inlineData: { data: 'Ag==' } }] } }] }));
    const provider = createGeminiProvider({ apiKey: 'key', fetch: fetchMock as typeof fetch });
    expect((await call(provider, 'gemini-image')).images[0]).toEqual(new Uint8Array([2]));
  });
});
