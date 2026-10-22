import { generateSpeech } from 'ai';
import { describe, expect, it } from 'vitest';
import { createFakeProvider } from '../support/fake-provider.ts';

describe('AI SDK speech compatibility', () => {
  it('supports generateSpeech through the audio model', async () => {
    const { provider, controller } = createFakeProvider();
    const result = await generateSpeech({
      model: provider.audioModel('demo-tts'),
      text: 'hello',
      maxRetries: 0,
    });

    expect(result.audio.uint8Array).toEqual(new Uint8Array([1, 2, 3]));
    expect(controller.starts).toBe(1);
  });
});
