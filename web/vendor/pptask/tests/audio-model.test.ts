import { describe, expect, it } from 'vitest';
import { subscribePptaskExecutions, type PptaskExecutionEvent } from '../src/index.ts';
import { createFakeProvider } from './support/fake-provider.ts';

describe('audio model kind', () => {
  it('describes an audio model as modelType audio', async () => {
    const { provider } = createFakeProvider();

    const description = await provider.describe(provider.audioModel('demo-tts'));

    expect(description).toMatchObject({
      providerId: 'fake',
      modelId: 'demo-tts',
      modelType: 'audio',
    });
  });

  it('runs a synchronous audio model through the jobs facade', async () => {
    const { provider } = createFakeProvider();
    const handle = await provider.jobs.start<{ audio: string }>({
      model: provider.audioModel('demo-tts'),
      input: { text: 'hello' },
    });

    // The record's modelType is what the worker persists and later re-resolves.
    expect((await handle.status()).modelType).toBe('audio');
    expect((await handle.wait()).audio).toBe('AQID');
  });

  it('reports execution facts tagged with the audio model type', async () => {
    const { provider } = createFakeProvider();
    const events: PptaskExecutionEvent[] = [];
    const unsubscribe = subscribePptaskExecutions(event => { events.push(event); });

    try {
      await provider.jobs.start({
        model: provider.audioModel('demo-tts'),
        input: { text: 'hello' },
      }).then(handle => handle.wait());
    } finally {
      unsubscribe();
    }

    expect(events.length).toBeGreaterThan(0);
    expect(events.every(event => event.modelType === 'audio')).toBe(true);
  });
});
