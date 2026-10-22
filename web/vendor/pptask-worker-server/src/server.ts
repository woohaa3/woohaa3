import type { ExecutionHistoryRepository } from './history/repository.js';
import { createPptaskExecutionHistory, type ExecutionRecord, type PptaskExecutionHistory } from './history/projection.js';
import type { PptaskDispatchNotifier, PptaskTaskRecord, PptaskTaskStore } from './task-store/types.js';
import { createPptaskWorker, DEFAULT_LEASE_MS, type PptaskWorker, type PptaskWorkerOptions, type PptaskWorkerSubmitInput, type PptaskWorkerSubmitResult } from './worker.js';
import type { PptaskJobRepository } from '@sdppp/pptask';

export type PptaskWorkerServerOptions = {
  taskStore: PptaskTaskStore;
  /** The ephemeral engine repository shared by the providers (jobs mode). */
  jobRepository: PptaskJobRepository;
  resolveProvider: PptaskWorkerOptions['resolveProvider'];
  /** Repository backing the execution-history projection. Defaults to in-memory. */
  historyRepository?: ExecutionHistoryRepository<ExecutionRecord>;
  /** Shared dispatch notifier; injected so hosts can observe/replace hints. */
  notifier?: PptaskDispatchNotifier;
  concurrency?: number;
  leaseMs?: number;
  /** Low-frequency, jittered recovery sweep period (safety net only). */
  recoveryIntervalMs?: number;
  recoveryJitterMs?: number;
  retryLimit?: number;
  retryBaseMs?: number;
  now?: () => Date;
  log?: (stage: string, details: Record<string, unknown>) => void;
  /** Receives stream-mode progress facts (SSE wiring point). */
  onEngineEvent?: PptaskWorkerOptions['onEngineEvent'];
  /** Receives dispatch lifecycle metrics/structured events. */
  onDispatchMetric?: PptaskWorkerOptions['onDispatchMetric'];
};

export type PptaskWorkerServer = {
  /** The underlying scheduler. */
  worker: PptaskWorker;
  /** Managed entry: dedup by key, then schedule. */
  submit(input: Omit<PptaskWorkerSubmitInput, never>): Promise<PptaskWorkerSubmitResult>;
  status(key: string): Promise<PptaskTaskRecord | null>;
  cancel(key: string): Promise<void>;
  /** Execution-history projection: scheduling + execution phases per task key. */
  history: PptaskExecutionHistory;
  /** Dispatcher counters, for observability and idle-query acceptance. */
  counters(): import('./dispatcher.js').PptaskDispatchCounters;
  /** Subscribes to projected records — filter by `record.id === key` for SSE. */
  subscribe(listener: (record: ExecutionRecord) => void): () => void;
  stop(): void;
  /** Aborts every in-flight provider drive (shutdown grace timeout). */
  abortAll(): void;
  /** Resolves when all in-flight drives have finished. */
  drained(): Promise<void>;
  /** stop() + drained() + release the history projection. */
  close(): Promise<void>;
};

/**
 * One-call composition: scheduling + the execution-history projection, wired
 * together. Scheduling facts flow into history records automatically (record
 * id = task key); stream-mode deltas accumulate into the same record.
 */
export async function createPptaskWorkerServer(options: PptaskWorkerServerOptions): Promise<PptaskWorkerServer> {
  const history = await createPptaskExecutionHistory({
    repository: options.historyRepository,
  });
  const worker = createPptaskWorker({
    taskStore: options.taskStore,
    jobRepository: options.jobRepository,
    resolveProvider: options.resolveProvider,
    notifier: options.notifier,
    concurrency: options.concurrency,
    leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS,
    recoveryIntervalMs: options.recoveryIntervalMs,
    recoveryJitterMs: options.recoveryJitterMs,
    retryLimit: options.retryLimit,
    retryBaseMs: options.retryBaseMs,
    now: options.now,
    log: options.log,
    reporter: (event) => history.ingestSchedulingEvent(event),
    onEngineEvent: options.onEngineEvent,
    onDispatchMetric: options.onDispatchMetric,
  });

  return {
    worker,
    async submit(input) {
      return worker.submit(input);
    },
    async status(key) {
      return worker.find(key);
    },
    async cancel(key) {
      await worker.cancel(key);
    },
    history,
    counters() {
      return worker.counters();
    },
    subscribe(listener) {
      return history.subscribe(listener);
    },
    stop() {
      worker.stop();
    },
    abortAll() {
      worker.abortAll();
    },
    async drained() {
      await worker.drained();
    },
    async close() {
      worker.stop();
      await worker.drained();
      await history.dispose();
    },
  };
}

export type { PptaskTaskRecord, PptaskTaskStore };
