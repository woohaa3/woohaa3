import { generateImage } from 'ai';
import { describe, expect, it } from 'vitest';
import { createFakeProvider } from '../support/fake-provider.ts';

describe('AI SDK compatibility', () => {
  it('supports generateImage through the async operation facade', async () => {
    const { provider, controller } = createFakeProvider();
    const result = await generateImage({
      model: provider.imageModel('demo'),
      prompt: 'AI SDK call',
      maxRetries: 0,
    });

    expect(result.image.uint8Array).toEqual(new Uint8Array([1, 2, 3]));
    expect(controller.starts).toBe(1);
    expect(controller.statuses).toBe(2);
  });
});
