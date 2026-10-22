/** Capture once per session; defer console output until after the measured window. */
let key = "";
let finished = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let rows: Record<string, unknown>[] = [];
function flush(reason: string) {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  rows.forEach((sample, index) => console.info("[shot-startup] host-batch " + JSON.stringify({ reason, part: index + 1, parts: rows.length, samples: [sample] })));
  rows = [];
  finished = true;
}
export function recordStartupFrame(kind: string, sample: { nodeId: string; generation?: number } & Record<string, unknown>) {
  const next = JSON.stringify([sample.nodeId, sample.generation]);
  if (next !== key) {
    flush("session-replaced");
    key = next;
    finished = false;
    timer = setTimeout(() => flush("window-complete"), 3000);
  }
  if (finished) return;
  rows.push({ kind, ...sample, atBrowserMs: performance.now() });
  if (rows.length >= 240) flush("sample-limit");
}
