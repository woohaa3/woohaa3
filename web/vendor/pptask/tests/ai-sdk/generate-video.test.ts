import { experimental_generateVideo as generateVideo } from 'ai';
import { describe, expect, it } from 'vitest';
import { createFakeProvider } from '../support/fake-provider.ts';

describe('AI SDK video compatibility', () => {
  it('supports the official doStart/doStatus flow', async () => {
    const { provider, controller } = createFakeProvider();
    const result = await generateVideo({
      model: provider.videoModel('demo-video'),
      prompt: 'A short clip',
      maxRetries: 0,
      poll: {
        intervalMs: 1,
        timeoutMs: 100,
        delay: async () => {},
      },
    });

    expect(result.video.uint8Array).toEqual(new Uint8Array([1, 2, 3]));
    expect(controller.starts).toBe(1);
    expect(controller.statuses).toBe(2);
  });
});
