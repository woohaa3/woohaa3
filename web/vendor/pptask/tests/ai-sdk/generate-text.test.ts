import { generateText, streamText } from 'ai';
import { describe, expect, it } from 'vitest';
import { createPptaskProvider, type PptaskLanguageModelImplementation } from '../../src/index.ts';

function createLanguageProvider() {
  let starts = 0;
  let statuses = 0;
  const implementation: PptaskLanguageModelImplementation = {
    supportedUrls: {},
    async doStart() {
      starts += 1;
      return { operation: { id: 'text-operation' } };
    },
    async doStatus() {
      statuses += 1;
      return {
        status: 'completed' as const,
        content: [{ type: 'text' as const, text: 'hello from pptask' }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 2, text: 2, reasoning: undefined },
        },
        warnings: [],
        response: {
          id: 'response-1',
          timestamp: new Date(),
          modelId: 'demo',
          headers: undefined,
        },
      };
    },
  };
  const provider = createPptaskProvider({
    providerId: 'fake-language',
    languageModel: () => implementation,
    pollIntervalMs: 1,
  });
  return { provider, getCounts: () => ({ starts, statuses }) };
}

describe('AI SDK language compatibility', () => {
  it('supports generateText through the async operation facade', async () => {
    const { provider, getCounts } = createLanguageProvider();
    const result = await generateText({
      model: provider.languageModel('demo'),
      prompt: 'hello',
      maxRetries: 0,
    });

    expect(result.text).toBe('hello from pptask');
    expect(getCounts()).toEqual({ starts: 1, statuses: 1 });
  });

  it('converts the final operation result into a valid stream', async () => {
    const { provider } = createLanguageProvider();
    const result = streamText({
      model: provider.languageModel('demo'),
      prompt: 'hello',
      maxRetries: 0,
    });

    await expect(result.text).resolves.toBe('hello from pptask');
  });
});
