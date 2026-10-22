import { describe, expect, it, vi } from 'vitest';
import { audioResult } from '../../src/providers/shared/output.ts';

const BASE64 = 'AQID'.repeat(8);

describe('audioResult', () => {
  it('wraps raw audio bytes returned by a text-to-speech endpoint', async () => {
    const result = await audioResult('fake', 'tts', new Uint8Array([1, 2, 3]), fetch);

    expect(result.audio).toBe('AQID');
    expect(result.audios).toEqual([{ type: 'base64', data: 'AQID', mediaType: 'audio/mpeg' }]);
  });

  it('accepts a bare base64 payload under the audio key', async () => {
    const result = await audioResult('fake', 'tts', { audio: BASE64 }, fetch);

    expect(result.audio).toBe(BASE64);
    expect(result.audios).toEqual([{ type: 'base64', data: BASE64, mediaType: 'audio/mpeg' }]);
  });

  it('handles the data url shape emitted by a sync audio endpoint', async () => {
    const result = await audioResult('fish', 'tts', { url: 'data:audio/wav;base64,AQID' }, fetch);

    expect(result.audio).toBe('AQID');
    expect(result.audios).toEqual([{ type: 'base64', data: 'AQID', mediaType: 'audio/wav' }]);
  });

  it('finds an audio_url emitted by an async job result', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([9, 9]))) as unknown as typeof fetch;
    const result = await audioResult('kie', 'tts', { audio_url: 'https://cdn.test/x.mp3' }, fetchMock);

    expect(result.audios).toEqual([{ type: 'url', url: 'https://cdn.test/x.mp3', mediaType: 'audio/mpeg' }]);
    expect(result.audio).toBe('CQk=');
  });

  it('keeps every url of a multi-track result and downloads the first', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      new Response(new Uint8Array(String(input).endsWith('a.mp3') ? [1, 2, 3] : [4, 5, 6])),
    ) as unknown as typeof fetch;

    const result = await audioResult('fake', 'music', {
      audios: ['https://cdn.test/a.mp3', 'https://cdn.test/b.mp3'],
    }, fetchMock);

    expect(result.audio).toBe('AQID');
    expect(result.audios).toEqual([
      { type: 'url', url: 'https://cdn.test/a.mp3', mediaType: 'audio/mpeg' },
      { type: 'url', url: 'https://cdn.test/b.mp3', mediaType: 'audio/mpeg' },
    ]);
    // Only the first output is materialised into the AI SDK's single `audio` field.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a payload with no audio output', async () => {
    await expect(audioResult('fake', 'tts', { unrelated: true }, fetch)).rejects.toThrow(
      'returned no audio output',
    );
  });
});
