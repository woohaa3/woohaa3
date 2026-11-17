/** Development-only playback evidence; never stores URLs or full pixel buffers. */
type Fields = Record<string, string | number | boolean | null | undefined>;
type Entry = Fields & { at: string; session: string; nodeId: string; stage: string; count: number };
type Trace = { log: (stage: string, fields?: Fields, immediate?: boolean) => void };
const frames = new WeakMap<object, { trace: Trace; sequence: number; mediaTime: number }>();
let nextSession = 0;

export function createVideoPlaybackTrace(nodeId: string): Trace {
  const session = `video-${Date.now().toString(36)}-${++nextSession}`;
  const stages = new Map<string, { at: number; count: number; signature?: string }>();
  return { log(stage, fields = {}, immediate = false) {
    if (!import.meta.env.DEV) return;
    // Diagnostics must not change playback, even when console observers fail.
    try {
      const now = Date.now();
      const previous = stages.get(stage) ?? { at: -Infinity, count: 0 };
      previous.count += 1;
      stages.set(stage, previous);
      const signature = stage === "texture-receipt" ? JSON.stringify(fields) : undefined;
      if (signature !== undefined && signature === previous.signature) return;
      if (!immediate && now - previous.at < 1000) return;
      previous.signature = signature;
      previous.at = now;
      const entry: Entry = { ...fields, at: new Date(now).toISOString(), session, nodeId, stage, count: previous.count };
      const host = globalThis as typeof globalThis & { __woohaaVideoPlaybackLog?: Entry[] };
      const log = host.__woohaaVideoPlaybackLog ??= [];
      log.push(entry);
      if (log.length > 200) log.splice(0, log.length - 200);
      console.info('[DEBUG-video-playback]', JSON.stringify(entry));
    } catch { /* Diagnostic failures cannot interrupt rendering. */ }
  } };
}

export function traceVideoPixels(pixels: Uint8Array, trace: Trace, sequence: number, mediaTime: number): void {
  if (!import.meta.env.DEV) return;
  frames.set(pixels, { trace, sequence, mediaTime });
  // Fixed-size sample distinguishes changing frames without copying/hash-scanning RGBA.
  let sample = 0;
  for (let i = 0; i < 32; i += 1) sample = (Math.imul(sample, 31) + (pixels[Math.floor(i * pixels.length / 32)] ?? 0)) >>> 0;
  trace.log('raster', { sequence, mediaTime, sample });
}

export function traceVideoTexture(pixels: object, stage: string, fields: Fields): void {
  const frame = frames.get(pixels);
  if (frame) frame.trace.log(stage, { ...fields, sequence: frame.sequence, mediaTime: frame.mediaTime });
}
