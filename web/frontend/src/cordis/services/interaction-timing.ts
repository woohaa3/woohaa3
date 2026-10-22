/// <reference types="vite/client" />
/** Synchronous event-owned timings. Async continuations never inherit this scope. */
export type InteractionTimingKey = "historyPlanMs" | "pendingProjectionMs" | "commandWireMs" | "statePublishMs";
type Measure = <T>(key: InteractionTimingKey, run: () => T) => T;
let current: Measure | undefined;
export function withInteractionTiming<T>(measure: Measure, run: () => T): T {
  if (!import.meta.env.DEV) return run();
  const previous = current;
  current = measure;
  try { return run(); } finally { current = previous; }
}
export function measureInteractionWork<T>(key: InteractionTimingKey, run: () => T): T {
  return current ? current(key, run) : run();
}
