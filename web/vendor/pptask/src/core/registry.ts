import type { PptaskJobListener, PptaskJobs } from './types.ts';

const sources = new Set<PptaskJobs>();
const listeners = new Set<(jobs: PptaskJobs) => void>();

/** Register a jobs API so integrations can discover providers in this process. */
export function registerPptaskJobs(jobs: PptaskJobs): () => void {
  sources.add(jobs);
  for (const listener of listeners) listener(jobs);
  return () => sources.delete(jobs);
}

/** Enumerate the jobs APIs created in this process. */
export function listPptaskJobs(): PptaskJobs[] {
  return [...sources];
}

/** Observe jobs APIs created after the subscriber is attached. */
export function subscribePptaskJobs(listener: (jobs: PptaskJobs) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type PptaskJobsRegistry = {
  list(): PptaskJobs[];
  subscribe(listener: (jobs: PptaskJobs) => void): () => void;
};

export const pptaskJobsRegistry: PptaskJobsRegistry = {
  list: listPptaskJobs,
  subscribe: subscribePptaskJobs,
};

export type { PptaskJobListener };
