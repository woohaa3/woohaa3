import {
  reportPptaskExecution,
  type PptaskJobHandle,
  type PptaskJobRecord,
  type PptaskJobRepository,
  type PptaskModelType,
  type PptaskProvider,
  type PptaskSchedulingEvent,
  type PptaskSchedulingStage,
} from '@sdppp/pptask';
import { streamText } from 'ai';
import {
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_RETRY_LIMIT,
  isRetryableError,
  retryDelayMs,
} from './retry.js';
import { createPptaskTaskDispatcher, type PptaskTaskDispatcher, createInProcessDispatchNotifier, DEFAULT_LEASE_MS } from './dispatcher.js';
import type {
  PptaskDispatchNotifier,
  PptaskDispatchWakeReason,
  PptaskTaskRecord,
  PptaskTaskStore,
} from './task-store/types.js';
import { isTaskTerminal } from './task-store/types.js';

export {
  DEFAULT_CONCURRENCY,
  DEFAULT_LEASE_MS,
  DEFAULT_RECOVERY_INTERVAL_MS,
  DEFAULT_RECOVERY_JITTER_MS,
  MIN_RECOVERY_INTERVAL_MS,
  createPptaskTaskDispatcher,
} from './dispatcher.js';
export type { PptaskDispatchCounters, PptaskDispatchMetric, PptaskTaskDispatcher } from './dispatcher.js';

/**
 * How the execution runs. `stream: true` drives the model's AI SDK stream
 * directly (no jobs API, deltas pushed as execution facts); otherwise the
 * task goes through core's jobs API (submit + poll).
 */
export type PptaskModelParams = {
  providerId?: string;
  modelType: PptaskModelType;
  modelId: string;
  input: unknown;
  stream?: boolean;
};

/** Job-mode recovery snapshot: where the remote execution lives. */
export type PptaskJobEngineState = {
  jobId?: string;
  record?: PptaskJobRecord;
};

/** Stream-mode recovery snapshot: the accumulated text (for replay). */
export type PptaskStreamEngineState = {
  text?: string;
};

export type PptaskWorkerSubmitInput = {
  key: string;
  providerId: string;
  modelType: PptaskModelType;
  modelId: string;
  input: unknown;
  /** Drive the model's AI SDK stream directly instead of the jobs API. */
  stream?: boolean;
  /** Opaque business context (tenant ids…), never credentials. */
  context?: unknown;
  /** Observability only. */
  ownerId?: string;
  /** Adopt an existing job: the task starts as `queued` from this snapshot. */
  state?: PptaskJobEngineState;
};

/** Observability hook for stream-mode progress facts (SSE wiring point). */
export type PptaskEngineEvent = {
  key: string;
  providerId: string;
  stage: string;
  detail?: unknown;
  at: string;
};

export type PptaskWorkerOptions = {
  taskStore: PptaskTaskStore;
  /**
   * The ephemeral engine repository shared by the providers. Job-mode
   * snapshots are rehydrated into it before resuming.
   */
  jobRepository: PptaskJobRepository;
  resolveProvider(
    providerId: string | undefined,
    record?: PptaskTaskRecord,
  ): PptaskProvider | undefined | Promise<PptaskProvider | undefined>;
  /**
   * Shared dispatch notifier. Submit/cancel publish hints through it; the
   * dispatcher subscribes. Defaults to a fresh in-process notifier.
   */
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
  /** Receives scheduling-side facts for projection into execution history. */
  reporter?: (event: PptaskSchedulingEvent) => void;
  /** Receives stream-mode progress facts. Reporting never alters scheduling. */
  onEngineEvent?: (event: PptaskEngineEvent) => void;
  /** Receives dispatch lifecycle metrics/structured events. */
  onDispatchMetric?: (metric: import('./dispatcher.js').PptaskDispatchMetric) => void;
};

export type PptaskWorkerSubmitResult = {
  record: PptaskTaskRecord;
  created: boolean;
};

export type PptaskWorker = {
  /** The single managed entry. Dedup, scheduling, retry, and recovery hang off it. */
  submit(input: PptaskWorkerSubmitInput): Promise<PptaskWorkerSubmitResult>;
  find(key: string): Promise<PptaskTaskRecord | null>;
  /** Cancels durably (fenced) and best-effort aborts the upstream execution. */
  cancel(key: string): Promise<void>;
  stop(): void;
  /** Aborts every in-flight provider drive and stops its heartbeat. */
  abortAll(): void;
  drained(): Promise<void>;
  /** Dispatcher counters, for observability and idle-query acceptance. */
  counters(): import('./dispatcher.js').PptaskDispatchCounters;
};

export function createPptaskWorker(options: PptaskWorkerOptions): PptaskWorker {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);
  const leaseMs = positiveInteger(options.leaseMs, DEFAULT_LEASE_MS);
  const retryLimit = positiveInteger(options.retryLimit, DEFAULT_RETRY_LIMIT);
  const retryBaseMs = positiveInteger(options.retryBaseMs, DEFAULT_RETRY_BASE_MS);

  const taskStore = options.taskStore;
  const notifier = options.notifier ?? createInProcessDispatchNotifier();
  /** In-process retry budget keyed by task key. Never persisted as truth. */
  const failureBudgets = new Map<string, number>();
  /** In-flight drives by task key, so cancel can abort them immediately. */
  const inFlightLeases = new Map<string, AbortController>();

  const report = (
    stage: PptaskSchedulingStage,
    event: Omit<PptaskSchedulingEvent, 'stage' | 'at'>,
  ): void => {
    if (!options.reporter) return;
    try {
      options.reporter({ ...event, stage, at: now().toISOString() });
    } catch {
      // Observers must not be able to break scheduling.
    }
  };

  function notify(key: string | undefined, reason: PptaskDispatchWakeReason): void {
    try {
      void notifier.publish(reason === 'submitted' ? { reason, ...(key ? { key } : {}) } : { reason });
    } catch (error) {
      // A notification is only a hint: never roll back durable work.
      log('dispatch-notify-failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function resolveProviderOrFail(providerId: string | undefined, record: PptaskTaskRecord): Promise<PptaskProvider> {
    const provider = await options.resolveProvider(providerId, record);
    if (!provider) throw new Error(`Provider not found: ${providerId ?? '(none)'}`);
    return provider;
  }

  function resolveModel(provider: PptaskProvider, modelType: PptaskModelType, modelId: string) {
    if (modelType === 'motion') return provider.motionModel(modelId);
    if (modelType === 'image') return provider.imageModel(modelId);
    if (modelType === 'video') return provider.videoModel(modelId);
    if (modelType === 'audio') return provider.audioModel(modelId);
    if (modelType === 'language') return provider.languageModel(modelId);
    throw new Error(`Unsupported model type: ${String(modelType)}`);
  }

  async function processClaim(claimed: PptaskTaskRecord): Promise<void> {
    const key = claimed.key;
    const { claimToken } = claimed;
    const params = (claimed.params ?? {}) as PptaskModelParams;
    const startedAt = now();
    log('claim', { key, providerId: claimed.providerId, attempt: claimed.attempt });
    report('claimed', { jobId: key, providerId: claimed.providerId, attempt: claimed.attempt });

    let provider: PptaskProvider;
    try {
      provider = await resolveProviderOrFail(claimed.providerId, claimed);
    } catch (error) {
      if (await parkInvalidSource(claimed, error, claimed.state)) return;
      log('provider-missing', { key, providerId: claimed.providerId });
      report('provider-missing', { jobId: key, providerId: claimed.providerId, attempt: claimed.attempt });
      await finishTask(claimed, 'failed');
      return;
    }

    const lease = new AbortController();
    inFlightLeases.set(key, lease);
    const heartbeatIntervalMs = Math.max(MIN_HEARTBEAT_INTERVAL_MS, Math.floor(leaseMs / 3));
    const heartbeat = setInterval(() => {
      void taskStore.heartbeat({
        key,
        claimToken: claimToken!,
        leaseUntil: new Date(now().getTime() + leaseMs),
        now: now(),
      }).then((renewed) => {
        if (!renewed) {
          // The lease was lost (cancel or takeover). Abort the drive; the
          // fencing check below keeps us from writing anything back.
          report('lease-lost', { jobId: key, providerId: claimed.providerId, attempt: claimed.attempt });
          lease.abort();
        }
      }, () => undefined);
    }, heartbeatIntervalMs);

    // Engine state updates are persisted through a serialized, fenced queue
    // so a crash after doStart never loses the accepted remote operation.
    let engineState: unknown = claimed.state;
    let syncQueue: Promise<void> = Promise.resolve();
    const updateEngineState = (state: unknown): void => {
      engineState = state;
      syncQueue = syncQueue.then(() => saveTask(claimed, { state })).catch(() => undefined);
    };

    try {
      let result: unknown;
      if (params.stream) {
        result = await driveStream(claimed, provider, params, lease.signal, updateEngineState);
      } else {
        result = await driveJob(key, provider, params, lease.signal, updateEngineState, () => engineState as PptaskJobEngineState);
      }
      log('task-succeeded', { key, elapsedMs: now().getTime() - startedAt.getTime() });
      failureBudgets.delete(key);
      await syncQueue;
      await saveTask(claimed, { result });
      report('task-completed', { jobId: key, providerId: claimed.providerId, attempt: claimed.attempt });
      await finishTask(claimed, 'completed');
    } catch (error) {
      await syncQueue;
      await handleDriveError(claimed, error, startedAt, () => lease.signal.aborted, () => engineState);
    } finally {
      clearInterval(heartbeat);
      inFlightLeases.delete(key);
    }
  }

  /** Once a remote receipt exists, invalid credentials park it for reconciliation.
   * No lease deadline means recovery cannot silently re-submit or use a new Key.
   */
  async function parkInvalidSource(claimed: PptaskTaskRecord, error: unknown, state: unknown): Promise<boolean> {
    if (!(error && typeof error === 'object' && (error as { sourceStale?: boolean }).sourceStale)) return false;
    const snapshot = state as { jobId?: string; record?: unknown } | undefined;
    if (!snapshot?.jobId && !snapshot?.record) return false;
    const current = await taskStore.find(claimed.key);
    if (!current || current.claimToken !== claimed.claimToken || isTaskTerminal(current.status)) return true;
    await taskStore.save({ ...current, state, status: 'executing', leaseUntil: undefined, nextRunAt: undefined, updatedAt: now() });
    report('provider-missing', { jobId: claimed.key, providerId: claimed.providerId, attempt: claimed.attempt,
      detail: { sourceStale: true, message: '服务来源已失效；保留上游回执，待核对。不会重新生成或改用新凭据。' } });
    return true;
  }

  /** Job mode: rehydrate (or create) the core job, then poll it to terminal. */
  async function driveJob(
    key: string,
    provider: PptaskProvider,
    params: PptaskModelParams,
    signal: AbortSignal,
    updateEngineState: (state: PptaskJobEngineState) => void,
    getState: () => PptaskJobEngineState,
  ): Promise<unknown> {
    const model = resolveModel(provider, params.modelType, params.modelId);
    const state = (getState() ?? {}) as PptaskJobEngineState;

    let handle: PptaskJobHandle;
    const existing = state.jobId
      ? await options.jobRepository.get<PptaskJobRecord>(state.jobId).catch(() => undefined)
      : undefined;
    if (existing) {
      // Job record still alive in the engine repository: plain resume.
      updateEngineState({ jobId: existing.id, record: existing });
      handle = await provider.jobs.resume(existing.id);
    } else if (state.record) {
      // Rehydrate the snapshot into the ephemeral repository, then resume —
      // the operation comes back with it, so doStart never runs again.
      updateEngineState({ jobId: state.record.id, record: state.record });
      await options.jobRepository.put(state.record);
      handle = await provider.jobs.resume(state.record.id);
    } else {
      // The task key rides in metadata so execution facts merge into the
      // task's history record.
      handle = await provider.jobs.start({ model, input: params.input, metadata: { taskKey: key } });
      updateEngineState({ jobId: handle.id, record: handle.record });
    }

    const liveSync = options.jobRepository.subscribe?.((change) => {
      if (change.job.id !== handle.id) return;
      updateEngineState({ jobId: handle.id, record: change.job });
    });

    try {
      const result = await handle.wait({ signal });
      const final = await options.jobRepository.get<PptaskJobRecord>(handle.id).catch(() => undefined);
      if (final) updateEngineState({ jobId: handle.id, record: final });
      return result;
    } catch (error) {
      if (signal.aborted) throw error;
      const record = await options.jobRepository.get<PptaskJobRecord>(handle.id).catch(() => undefined);
      if (record?.state === 'cancelled') {
        throw new Error(`Job cancelled: ${handle.id}`);
      }
      // Provider-declared failures leave the record terminal (`failed`).
      // Keep the record's structured fields on the thrown error: the retry
      // decision otherwise degrades to keyword matching on the message, and a
      // provider that said "don't retry" (retryable === false) would be retried
      // whenever its text happens to contain e.g. "不可用".
      if (record?.state === 'failed') {
        const declared = new Error(record.error?.message ?? `Job failed: ${handle.id}`) as Error & {
          code?: string;
          retryable?: boolean;
        };
        if (record.error?.code !== undefined) declared.code = record.error.code;
        if (record.error?.retryable !== undefined) declared.retryable = record.error.retryable;
        throw declared;
      }
      throw error;
    } finally {
      liveSync?.();
    }
  }

  /**
   * Stream mode: drive the model's AI SDK stream directly. Deltas are pushed
   * as execution facts (executionId = task key) so the history projection
   * accumulates them; nothing goes through the jobs API.
   */
  async function driveStream(
    claimed: PptaskTaskRecord,
    provider: PptaskProvider,
    params: PptaskModelParams,
    signal: AbortSignal,
    updateEngineState: (state: PptaskStreamEngineState) => void,
  ): Promise<unknown> {
    if (params.modelType !== 'language') {
      throw new Error('stream mode requires a language model');
    }
    const model = resolveModel(provider, params.modelType, params.modelId);
    const input = (params.input ?? {}) as Record<string, unknown>;
    const providerId = params.providerId ?? claimed.providerId;
    const at = () => new Date().toISOString();

    reportPptaskExecution({
      type: 'started',
      executionId: claimed.key,
      jobId: claimed.key,
      providerId,
      modelType: 'language',
      modelId: params.modelId,
      at: at(),
      detail: { transition: 'stream-started' },
    });

    const stream = streamText({
      ...(input as Record<string, never>),
      model: model as never,
      abortSignal: signal,
    } as never);

    let text = '';
    for await (const delta of stream.textStream) {
      text += delta;
      updateEngineState({ text });
      reportPptaskExecution({
        type: 'progress',
        executionId: claimed.key,
        jobId: claimed.key,
        providerId,
        modelType: 'language',
        modelId: params.modelId,
        at: at(),
        state: 'running',
        detail: { phase: 'delta', text: delta },
      });
    }
    const full = await stream.text;
    reportPptaskExecution({
      type: 'succeeded',
      executionId: claimed.key,
      jobId: claimed.key,
      providerId,
      modelType: 'language',
      modelId: params.modelId,
      at: at(),
      state: 'succeeded',
      result: { text: full },
    });
    return { text: full };
  }

  async function handleDriveError(
    claimed: PptaskTaskRecord,
    error: unknown,
    startedAt: Date,
    isLeaseAborted: () => boolean,
    currentEngineState: () => unknown,
  ): Promise<void> {
    const key = claimed.key;
    log('task-error', {
      key,
      providerId: claimed.providerId,
      elapsedMs: now().getTime() - startedAt.getTime(),
      error: error instanceof Error ? error.message : String(error),
    });

    // Fencing check: cancel or a lease takeover may have replaced us while
    // the drive was running. Never write back after that.
    const current = await taskStore.find(key);
    if (!current || current.claimToken !== claimed.claimToken || isTaskTerminal(current.status)) return;
    if (isLeaseAborted()) return;

    if (await parkInvalidSource(claimed, error, currentEngineState())) return;
    const state = (currentEngineState() ?? {}) as PptaskJobEngineState;

    let record: PptaskJobRecord | undefined;
    if (state.jobId) {
      try {
        record = await options.jobRepository.get<PptaskJobRecord>(state.jobId).catch(() => undefined);
      } catch {
        record = undefined;
      }
      if (!record) {
        // 作业记录不在 worker 的 jobRepository 里（远端托管 Provider 的作业属于扩展自己的
        // engine）。这里必须**也**上报调度失败：只改调度行而不 report，订阅方（执行历史 →
        // 画布投影）永远收不到终态，界面会一直停在「执行中」。
        const message = error instanceof Error ? error.message : String(error);
        log('task-failed', { key, error: message });
        report('task-failed', {
          jobId: key,
          providerId: claimed.providerId,
          attempt: claimed.attempt,
          consecutiveFailures: 1,
          // 失败原因要随调度事实一起进投影：否则历史/画布只能拿到「失败了」，
          // 而拿不到为什么（2026-10-21 现场：错误消息在这里被整段丢掉）。
          detail: { message },
        });
        await finishTask(claimed, 'failed', 1);
        return;
      }
    }
    if (record?.state === 'succeeded') {
      failureBudgets.delete(key);
      await finishTask(claimed, 'completed');
      return;
    }
    if (record?.state === 'cancelled') {
      await finishTask(claimed, 'cancelled');
      return;
    }

    const failures = (failureBudgets.get(key) ?? 0) + 1;
    const retryable = isRetryableError(error) && failures < retryLimit;
    if (!retryable) {
      failureBudgets.delete(key);
      log('task-failed', { key, failures, error: error instanceof Error ? error.message : String(error) });
      report('task-failed', {
        jobId: key,
        providerId: claimed.providerId,
        attempt: claimed.attempt,
        consecutiveFailures: failures,
        detail: { message: error instanceof Error ? error.message : String(error) },
      });
      await finishTask(claimed, 'failed', failures);
      return;
    }

    failureBudgets.set(key, failures);
    const nextRunAt = new Date(now().getTime() + retryDelayMs(failures, retryBaseMs));
    if (record?.state === 'failed') {
      // Provider-declared failure: the job went terminal. Flip it back to
      // `pending` keeping the operation so the next drive polls instead of
      // re-submitting. A racing host-side watcher may re-fail the job once;
      // the next retry un-fails it again within the budget.
      try {
        await options.jobRepository.update(state.jobId!, (job) => ({
          ...job,
          state: 'pending',
          error: undefined,
          finishedAt: undefined,
          updatedAt: now().toISOString(),
        }));
      } catch {
        report('task-failed', { jobId: key, providerId: claimed.providerId, attempt: claimed.attempt, consecutiveFailures: failures });
        await finishTask(claimed, 'failed', failures);
        return;
      }
      report('unfail-retry', {
        jobId: key,
        providerId: claimed.providerId,
        attempt: claimed.attempt,
        consecutiveFailures: failures,
        detail: { nextRunAt: nextRunAt.toISOString() },
      });
      log('unfail-retry', { key, failures, nextRunAt: nextRunAt.toISOString() });
    } else {
      report('transient-retry', {
        jobId: key,
        providerId: claimed.providerId,
        attempt: claimed.attempt,
        consecutiveFailures: failures,
        detail: { nextRunAt: nextRunAt.toISOString() },
      });
      log('transient-retry', { key, failures, nextRunAt: nextRunAt.toISOString() });
    }
    await rescheduleTask(claimed, nextRunAt, failures);
  }

  async function finishTask(
    claimed: PptaskTaskRecord,
    status: 'completed' | 'failed' | 'cancelled',
    consecutiveFailures?: number,
  ): Promise<void> {
    await saveTask(claimed, {
      status,
      ...(consecutiveFailures === undefined ? {} : { consecutiveFailures }),
    });
  }

  async function rescheduleTask(
    claimed: PptaskTaskRecord,
    nextRunAt: Date,
    failures: number,
  ): Promise<void> {
    // Durable save first; only then arrange the timer. A crash in between is
    // recovered from `nextRunAt` by startup recovery / nextWakeAt.
    await saveTask(claimed, {
      status: 'queued',
      nextRunAt,
      consecutiveFailures: failures,
    });
    dispatcher.schedule(claimed.key, nextRunAt);
  }

  async function saveTask(
    claimed: PptaskTaskRecord,
    patch: Partial<PptaskTaskRecord>,
  ): Promise<void> {
    const current = await taskStore.find(claimed.key);
    if (!current || current.claimToken !== claimed.claimToken || isTaskTerminal(current.status)) return;
    await taskStore.save({
      ...current,
      ...patch,
      // The lease survives mid-drive syncs; only an explicit non-executing
      // status change releases it.
      leaseUntil: patch.status === undefined || patch.status === 'executing'
        ? current.leaseUntil
        : undefined,
      nextRunAt: patch.nextRunAt,
      updatedAt: now(),
    });
  }

  const dispatcher: PptaskTaskDispatcher = createPptaskTaskDispatcher({
    taskStore,
    notifier,
    execute: processClaim,
    concurrency: options.concurrency,
    leaseMs,
    recoveryIntervalMs: options.recoveryIntervalMs,
    recoveryJitterMs: options.recoveryJitterMs,
    now,
    log,
    ...(options.onDispatchMetric ? { metrics: options.onDispatchMetric } : {}),
  });
  dispatcher.start();

  const worker: PptaskWorker = {
    async submit(input): Promise<PptaskWorkerSubmitResult> {
      const params: PptaskModelParams = {
        providerId: input.providerId,
        modelType: input.modelType,
        modelId: input.modelId,
        input: input.input,
        ...(input.stream ? { stream: true } : {}),
      };
      const result = await taskStore.submit({
        key: input.key,
        providerId: input.providerId,
        params,
        ...(input.context !== undefined ? { context: input.context } : {}),
        ...(input.ownerId ? { ownerId: input.ownerId } : {}),
        ...(input.state !== undefined ? { state: input.state } : {}),
        now: now(),
      });
      if (result.created) {
        report('enqueued', { jobId: input.key, providerId: input.providerId });
      }
      // Notify after durable commit only. A duplicate hit on a non-terminal
      // record may repair a lost notification; terminal hits never re-run.
      if (result.created || !isTaskTerminal(result.record.status)) {
        notify(input.key, 'submitted');
      }
      return result;
    },
    async find(key) {
      return taskStore.find(key);
    },
    async cancel(key) {
      const cancelled = await taskStore.cancel(key, now());
      if (!cancelled) return;
      report('task-cancelled', { jobId: key, providerId: cancelled.providerId, attempt: cancelled.attempt });
      // Durable terminal is already written: only now signal the dispatcher to
      // supersede delayed hints, then abort any in-flight drive (fenced).
      dispatcher.cancel(key);
      inFlightLeases.get(key)?.abort();
      const state = (cancelled.state ?? {}) as PptaskJobEngineState;
      if (!state.jobId) return; // stream mode aborts via the drive's lease signal
      const params = (cancelled.params ?? {}) as PptaskModelParams;
      const provider = await options.resolveProvider(params.providerId ?? cancelled.providerId);
      if (!provider) return;
      try {
        // jobs.cancel both cancels upstream and settles the core job record.
        await provider.jobs.cancel(state.jobId);
      } catch {
        // Cancellation stays durable even when the provider has no cancel API.
      }
    },
    stop() {
      dispatcher.stopAccepting();
    },
    abortAll() {
      for (const lease of inFlightLeases.values()) lease.abort();
      inFlightLeases.clear();
    },
    async drained() {
      await dispatcher.drained();
    },
    counters() {
      return dispatcher.counters();
    },
  };

  return worker;
}

const MIN_HEARTBEAT_INTERVAL_MS = 5_000;

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : fallback;
}
