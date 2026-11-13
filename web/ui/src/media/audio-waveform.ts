type Samples = Pick<AudioBuffer, "length" | "numberOfChannels" | "getChannelData">;

/** Real peak envelope, preserving transients in every channel. */
export function audioPeaks(buffer: Samples, bars = 128): number[] {
  const count = Math.min(Math.max(1, bars), buffer.length);
  const peaks = Array.from({ length: count }, () => 0);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let bar = 0; bar < count; bar++) {
      const end = Math.floor((bar + 1) * buffer.length / count);
      for (let i = Math.floor(bar * buffer.length / count); i < end; i++) {
        peaks[bar] = Math.max(peaks[bar]!, Math.abs(samples[i]!));
      }
    }
  }
  const maximum = Math.max(...peaks);
  return maximum > 0 ? peaks.map(value => value / maximum) : peaks;
}

type Entry = { promise: Promise<number[]>; abort: AbortController; users: number; done: boolean };
const cache = new Map<string, Entry>();
// Serialize PCM allocations; retain only small peak arrays after decoding.
let decoding: Promise<unknown> = Promise.resolve();
export function acquireAudioWaveform(url: string) {
  let entry = cache.get(url);
  if (!entry) {
    const abort = new AbortController();
    const created: Entry = { abort, users: 0, done: false, promise: Promise.resolve([]) };
    created.promise = decoding.catch(() => {}).then(async () => {
      abort.signal.throwIfAborted();
      const response = await fetch(url, { signal: abort.signal });
      if (!response.ok) throw new Error("waveform-read");
      if (Number(response.headers.get("content-length")) > 32 * 1024 * 1024) throw new Error("waveform-size");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 32 * 1024 * 1024) throw new Error("waveform-size");
      abort.signal.throwIfAborted();
      const context = new AudioContext();
      try {
        const buffer = await context.decodeAudioData(bytes);
        abort.signal.throwIfAborted();
        return audioPeaks(buffer);
      } finally { await context.close(); }
    }).then(peaks => {
      created.done = true;
      for (const [key, value] of cache) {
        if (cache.size <= 24) break;
        if (value.done && value.users === 0) cache.delete(key);
      }
      return peaks;
    }).catch(error => {
      if (cache.get(url) === created) cache.delete(url);
      throw error;
    });
    decoding = created.promise.catch(() => {});
    cache.set(url, created); entry = created;
  }
  entry.users++;
  const current = entry;
  return { promise: current.promise, release: () => {
    current.users--;
    if (current.users === 0 && !current.done) {
      current.abort.abort();
      if (cache.get(url) === current) cache.delete(url);
    }
  } };
}
