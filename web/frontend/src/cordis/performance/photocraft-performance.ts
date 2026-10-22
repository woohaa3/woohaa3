/** Record-scoped CPU timings; submission return is not GPU completion. */
type Stage = { calls: number; totalMs: number; maxMs: number; bytes: number; failures: number; samples: number[]; lastWidth?: number; lastHeight?: number };
let active = false;
let stages: Record<string, Stage> = {};
let traces = new WeakMap<Uint8Array, { started: number; kind: string }>();
export function beginPhotocraftProfile(): void { active = true; stages = {}; traces = new WeakMap(); }
function record(name: string, ms: number, bytes: number, failed: boolean): void {
  const stage = stages[name] ??= { calls: 0, totalMs: 0, maxMs: 0, bytes: 0, failures: 0, samples: [] };
  stage.calls++; stage.totalMs += ms; stage.maxMs = Math.max(stage.maxMs, ms); stage.bytes += bytes;
  if (failed) stage.failures++;
  if (stage.samples.length < 4096) stage.samples.push(ms);
}
export function measurePhotocraft<T>(name: string, invoke: () => T, bytes = 0): T {
  if (!active) return invoke();
  const started = performance.now(); let failed = true;
  try { const value = invoke(); failed = false; return value; }
  finally { record(name, performance.now() - started, bytes, failed); }
}
export function photocraftPreview<T extends { width: number; height: number; pixels: Uint8Array }>(kind: string, invoke: () => T): T {
  if (!active) return invoke();
  const started = performance.now();
  const value = invoke();
  traces.set(value.pixels, { started, kind });
  record(`${kind}.output`, 0, value.pixels.byteLength, false);
  stages[`${kind}.output`].lastWidth = value.width;
  stages[`${kind}.output`].lastHeight = value.height;
  return value;
}
export function submitPhotocraftTexture<T>(pixels: Uint8Array, invoke: () => T): T {
  const trace = active ? traces.get(pixels) : undefined;
  if (!trace) return invoke();
  const result = measurePhotocraft(`${trace.kind}.texture-submit`, invoke, pixels.byteLength);
  if (result !== false) record(`${trace.kind}.preview-to-submit`, performance.now() - trace.started, 0, false);
  return result;
}
export function endPhotocraftProfile() {
  active = false;
  const result = Object.fromEntries(Object.entries(stages).map(([name, stage]) => {
    const sorted = [...stage.samples].sort((a, b) => a - b);
    const percentile = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
    const { samples, ...counts } = stage;
    return [name, { ...counts, sampleCount: samples.length, p50Ms: percentile(.5), p95Ms: percentile(.95) }];
  }));
  traces = new WeakMap();
  return { stages: result };
}
