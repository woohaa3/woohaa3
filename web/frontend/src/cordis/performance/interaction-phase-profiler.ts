/** Recorder-scoped nested CPU timings. Self time excludes measured child phases. */
type Phase = { calls: number; totalMs: number; selfMs: number; maxMs: number };
let active = false;
let phases: Record<string, Phase> = {};
let slowFrames: Array<{ atMs: number; totalMs: number; phases: Record<string, number> }> = [];
let frameParts: Record<string, number> | null = null;
const stack: Array<{ childMs: number }> = [];
export function beginInteractionProfile(): void {
  phases = {}; slowFrames = []; frameParts = null; active = true;
  captureStarted = performance.now(); videoEvents = []; videoEventsDropped = 0;
  slowOperations = []; slowOperationsDropped = 0;
}
export function endInteractionProfile() {
  active = false;
  return { phases: structuredClone(phases), slowFrames: structuredClone(slowFrames), videoEvents: structuredClone(videoEvents), videoEventsDropped, slowOperations: structuredClone(slowOperations), slowOperationsDropped };
}
export function measureInteractionPhase<T>(name: string, invoke: () => T, now = () => performance.now()): T {
  if (!active) return invoke();
  const started = now(), entry = { childMs: 0 };
  const previousParts = frameParts;
  if (name === "frame") frameParts = {};
  stack.push(entry);
  try { return invoke(); }
  finally {
    const totalMs = Math.max(0, now() - started), selfMs = Math.max(0, totalMs - entry.childMs);
    if (name !== "frame" && totalMs >= 4) {
      if (slowOperations.length < 256) slowOperations.push({ name, atMs: Math.max(0, started - captureStarted), totalMs, selfMs });
      else slowOperationsDropped++;
    }
    stack.pop();
    const parent = stack.at(-1); if (parent) parent.childMs += totalMs;
    const phase = phases[name] ??= { calls: 0, totalMs: 0, selfMs: 0, maxMs: 0 };
    phase.calls++; phase.totalMs += totalMs; phase.selfMs += selfMs; phase.maxMs = Math.max(phase.maxMs, totalMs);
    if (frameParts) frameParts[name] = (frameParts[name] ?? 0) + selfMs;
    if (name === "frame") {
      slowFrames.push({ atMs: Math.max(0, started - captureStarted), totalMs, phases: frameParts! });
      slowFrames.sort((a, b) => b.totalMs - a.totalMs); slowFrames.length = Math.min(8, slowFrames.length);
      frameParts = previousParts;
    }
  }
}

/** Bounded video timeline: state changes and operations taking at least 4 ms. */
export function recordVideoTransition(name: string, sessionCount: number): void {
  if (!active) return;
  appendVideoEvent({ name, atMs: performance.now() - captureStarted, sessionCount });
}
export function measureVideoPhase<T>(name: string, nodeId: string | null, invoke: () => T): T {
  if (!active) return invoke();
  const started = performance.now();
  try { return measureInteractionPhase(`video.${name}`, invoke); }
  finally {
    const durationMs = performance.now() - started;
    if (durationMs >= 4) appendVideoEvent({ name, nodeId, atMs: started - captureStarted, durationMs });
  }
}
type VideoEvent = { name: string; atMs: number; durationMs?: number; nodeId?: string | null; sessionCount?: number };
let captureStarted = 0;
let videoEvents: VideoEvent[] = [];
let videoEventsDropped = 0;
function appendVideoEvent(event: VideoEvent): void {
  if (videoEvents.length < 256) videoEvents.push(event);
  else videoEventsDropped++;
}

let slowOperations: Array<{ name: string; atMs: number; totalMs: number; selfMs: number }> = [];
let slowOperationsDropped = 0;
