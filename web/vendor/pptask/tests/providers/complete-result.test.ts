import { describe, expect, it, vi } from 'vitest';
import { createHttpProvider } from '../../src/providers/shared/provider.ts';
import type { HttpProviderProtocol } from '../../src/providers/shared/types.ts';

/**
 * `completeResult` 完成钩子（change: 2026-11-06-add-litellm-local-video）。
 *
 * 不实现钩子的 Provider 行为必须完全不变；实现钩子的异步任务可以返回稳定媒体引用，
 * 而不是被 `videoResult` 判成「没有视频输出」。
 */

const OPERATION = { id: 'video-op-1' };
const STABLE_MEDIA = {
  storageKey: `sha256-${'a'.repeat(64)}`,
  contentType: 'video/mp4',
  size: 1024,
  checksum: 'a'.repeat(64),
  durationSeconds: 4
};

function videoProtocol(overrides: Partial<HttpProviderProtocol> = {}): HttpProviderProtocol {
  return {
    providerId: 'complete-test',
    fetch: vi.fn() as unknown as typeof fetch,
    mode: (_modelId, modelType) => (modelType === 'video' ? 'async' : 'sync'),
    start: async () => ({ operation: OPERATION }),
    status: async () => ({ state: 'completed', output: { media: STABLE_MEDIA } }),
    ...overrides,
  };
}

async function runVideo(protocol: HttpProviderProtocol): Promise<unknown> {
  const provider = createHttpProvider(protocol, { pollIntervalMs: 1 });
  const handle = await provider.jobs.start({
    model: provider.videoModel('video-model'),
    input: { prompt: 'a quiet studio' },
  });
  return handle.wait();
}

describe('HttpProviderProtocol.completeResult', () => {
  it('keeps the built-in video normalisation when the hook is absent', async () => {
    const protocol = videoProtocol({
      status: async () => ({ state: 'completed', output: { url: 'https://cdn.example/out.mp4' } }),
    });

    const result = await runVideo(protocol) as { videos: Array<{ type: string; url?: string }> };

    expect(result.videos).toEqual([{ type: 'url', url: 'https://cdn.example/out.mp4', mediaType: 'video/mp4' }]);
  });

  it('returns the stable media result instead of failing "no video output"', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const protocol = videoProtocol({
      completeResult: (context) => {
        calls.push({
          modelId: context.modelId,
          modelType: context.modelType,
          output: context.output,
          operation: context.operation,
        });
        return context.output;
      },
    });

    const result = await runVideo(protocol) as { media: typeof STABLE_MEDIA };

    expect(result.media).toEqual(STABLE_MEDIA);
    expect(result).not.toHaveProperty('videos');
    expect(calls).toEqual([{
      modelId: 'video-model',
      modelType: 'video',
      output: { media: STABLE_MEDIA },
      operation: OPERATION,
    }]);
  });

  it('lets language, image and audio async results use the same hook', async () => {
    const hook = (context: { modelType: string }) => ({ fromHook: context.modelType });
    const base = {
      providerId: 'complete-test',
      fetch: vi.fn() as unknown as typeof fetch,
      mode: () => 'async' as const,
      start: async () => ({ operation: { id: 'op' } }),
      status: async () => ({ state: 'completed' as const, output: {} }),
      completeResult: hook,
    };

    for (const [modelType, model] of [
      ['language', (provider: ReturnType<typeof createHttpProvider>) => provider.languageModel('m')],
      ['image', (provider: ReturnType<typeof createHttpProvider>) => provider.imageModel('m')],
      ['audio', (provider: ReturnType<typeof createHttpProvider>) => provider.audioModel('m')],
    ] as const) {
      const provider = createHttpProvider(base, { pollIntervalMs: 1 });
      const handle = await provider.jobs.start({ model: model(provider), input: {} });
      expect(await handle.wait()).toMatchObject({ fromHook: modelType });
    }
  });
});
