import type { PptaskModelType, PptaskSerializedError } from './types.ts';

export type PptaskExecutionEvent = {
  type: 'created' | 'started' | 'progress' | 'succeeded' | 'failed' | 'cancelled';
  executionId: string;
  jobId?: string;
  providerId: string;
  modelType: PptaskModelType;
  modelId: string;
  at: string;
  progress?: number;
  state?: string;
  detail?: unknown;
  metadata?: Record<string, unknown>;
  operation?: unknown;
  result?: unknown;
  error?: PptaskSerializedError;
};

export type PptaskExecutionReporter = (event: PptaskExecutionEvent) => void;

const listeners = new Set<PptaskExecutionReporter>();

/** Subscribe to execution facts emitted by all Pptask providers in this process. */
export function subscribePptaskExecutions(listener: PptaskExecutionReporter): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Publish an execution fact without allowing observers to affect the request. */
export function reportPptaskExecution(event: PptaskExecutionEvent): void {
  for (const listener of listeners) {
    try { listener(event); } catch { /* observers must not affect execution */ }
  }
}

/** Send an event to the process feed and an optional application-owned sink. */
export function emitPptaskExecution(
  reporter: PptaskExecutionReporter | undefined,
  event: PptaskExecutionEvent,
): void {
  reportPptaskExecution(event);
  if (reporter && reporter !== reportPptaskExecution) {
    try { reporter(event); } catch { /* application reporters must not affect execution */ }
  }
}
