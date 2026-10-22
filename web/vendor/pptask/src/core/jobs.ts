import {
  createAbortError,
  createId,
  delay,
  getModelType,
  isAbortError,
  sanitizePersistedInput,
  serializeError,
  throwIfAborted,
} from './internal.ts';
import { emitPptaskExecution, type PptaskExecutionReporter } from './execution.ts';
import { executePptaskModelGenerate } from './model.ts';
import type {
  PptaskJobHandle,
  PptaskJobRecord,
  PptaskJobCallOptions,
  PptaskJobs,
  PptaskJobRepository,
  PptaskJobListener,
  PptaskJobTransition,
  PptaskModel,
  PptaskModelType,
} from './types.ts';

type CreateJobsOptions = {
  providerId: string;
  store: PptaskJobRepository;
  pollIntervalMs: number;
  maxStatusErrors: number;
  resolveModel(type: PptaskModelType, modelId: string): PptaskModel;
  reporter?: PptaskExecutionReporter;
};

export function createJobs(options: CreateJobsOptions): PptaskJobs {
  const inFlightStarts = new Map<string, Promise<void>>();
  const listeners = new Set<PptaskJobListener>();
  const internalWrites = new Set<string>();
  const hasStoreChangeFeed = typeof options.store.subscribe === 'function';

  function publish(job: PptaskJobRecord): void {
    const event = { type: 'state' as const, job };
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Observers must not be able to break job execution.
      }
    }
  }

  options.store.subscribe?.(event => {
    if (event.job.providerId !== options.providerId) return;
    publish(event.job);
    if (!internalWrites.has(event.job.id)) {
      const type = event.job.state === 'succeeded'
        ? 'succeeded'
        : event.job.state === 'failed'
          ? 'failed'
          : event.job.state === 'cancelled'
            ? 'cancelled'
            : event.type === 'created' ? 'started' : 'progress';
      reportJobEvent(event.job, type, { source: 'repository', change: event.type });
    }
  });

  async function updateRecord<RESULT = unknown>(
    jobId: string,
    updater: (record: PptaskJobRecord<RESULT>) => PptaskJobRecord<RESULT>,
  ): Promise<PptaskJobRecord<RESULT>> {
    internalWrites.add(jobId);
    let updated: PptaskJobRecord<RESULT>;
    try {
      updated = await options.store.update(jobId, updater);
    } finally {
      internalWrites.delete(jobId);
    }
    if (!hasStoreChangeFeed) publish(updated);
    return updated;
  }

  function transition<RESULT>(
    record: PptaskJobRecord<RESULT>,
    type: PptaskJobTransition['type'],
    at: string,
  ): PptaskJobRecord<RESULT> {
    const transitions = [...(record.transitions ?? [])];
    transitions.push({ at, type, state: record.state, progress: record.progress });
    return { ...record, transitions };
  }

  async function start<RESULT = unknown>({
    model,
    input,
    metadata,
  }: {
    model: PptaskModel;
    input: unknown;
    metadata?: Record<string, unknown>;
  }): Promise<PptaskJobHandle<RESULT>> {
    if (model.provider !== options.providerId) {
      throw new Error(`Model provider ${model.provider} does not match ${options.providerId}`);
    }
    const now = new Date().toISOString();
    const record: PptaskJobRecord = {
      schemaVersion: 1,
      id: createId('job'),
      providerId: options.providerId,
      modelType: getModelType(model),
      modelId: model.modelId,
      state: 'creating',
      input: sanitizePersistedInput(input),
      metadata: metadata ? sanitizePersistedInput(metadata) as Record<string, unknown> : undefined,
      transitions: [{ at: now, type: 'created', state: 'creating' }],
      createdAt: now,
      updatedAt: now,
    };
    internalWrites.add(record.id);
    try {
      await options.store.create(record);
    } finally {
      internalWrites.delete(record.id);
    }
    if (!hasStoreChangeFeed) publish(record);
    reportJobEvent(record, 'created');
    await startRecordOnce(record, model, input);
    return createHandle<RESULT>(await ensureRecord(record.id));
  }

  const jobs: PptaskJobs = {
    start,
    async resume<RESULT>(jobId: string) {
      const record = await ensureRecord<RESULT>(jobId);
      if (record.providerId !== options.providerId) {
        throw new Error(`Job ${jobId} belongs to provider ${record.providerId}`);
      }
      return createHandle<RESULT>(record);
    },
    status: pollStatus,
    watch,
    wait,
    updateResult,
    cancel,
    list: filter => options.store.list(filter),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  function createHandle<RESULT>(record: PptaskJobRecord<RESULT>): PptaskJobHandle<RESULT> {
    const id = record.id;
    return {
      id,
      record,
      status: statusOptions => jobs.status<RESULT>(id, statusOptions),
      watch: watchOptions => jobs.watch<RESULT>(id, watchOptions),
      wait: waitOptions => jobs.wait<RESULT>(id, waitOptions),
      cancel: cancelOptions => jobs.cancel(id, cancelOptions),
    };
  }

  function startRecordOnce(
    record: PptaskJobRecord,
    model: PptaskModel,
    executionInput?: unknown,
  ): Promise<void> {
    const existing = inFlightStarts.get(record.id);
    if (existing) return existing;
    const started = startRecord(record, model, executionInput).finally(() => {
      inFlightStarts.delete(record.id);
    });
    inFlightStarts.set(record.id, started);
    return started;
  }

  async function startRecord(
    record: PptaskJobRecord,
    model: PptaskModel,
    executionInput: unknown = record.input,
  ): Promise<void> {
    try {
      const submittingAt = new Date().toISOString();
      const submitting = await updateRecord(record.id, current => transition(
        { ...current, startedAt: current.startedAt ?? submittingAt },
        'submitting',
        submittingAt,
      ));
      if (model.doStart && model.doStatus) reportJobEvent(submitting, 'started', { transition: 'submitting' });
      if (model.doStart && model.doStatus) {
        const started = await model.doStart(executionInput as never, {
          jobId: record.id,
        });
        const acceptedAt = new Date().toISOString();
        const accepted = await updateRecord(record.id, current => transition({
          ...current,
          operation: started.operation,
          state: 'pending',
          error: undefined,
          updatedAt: acceptedAt,
        }, 'accepted', acceptedAt));
        reportJobEvent(accepted, 'progress', { phase: 'accepted', transition: 'accepted' });
        return;
      }

      if (!model.doGenerate) throw new Error('Model does not support generation or operations');
      const result = await executePptaskModelGenerate(model, executionInput, {
        executionId: record.id,
        jobId: record.id,
        metadata: record.metadata,
        reporter: options.reporter,
      });
      const finishedAt = new Date().toISOString();
      await updateRecord(record.id, current => transition({
        ...current,
        state: 'succeeded',
        result,
        finishedAt,
        updatedAt: finishedAt,
      }, 'succeeded', finishedAt));
    } catch (error) {
      if (isAbortError(error)) throw error;
      const finishedAt = new Date().toISOString();
      const failed = await updateRecord(record.id, current => transition({
        ...current,
        error: serializeError(error),
        state: 'failed',
        finishedAt,
        updatedAt: finishedAt,
      }, 'failed', finishedAt));
      if (model.doStart && model.doStatus) reportJobEvent(failed, 'failed', { transition: 'failed' });
      throw error;
    }
  }

  async function pollStatus<RESULT>(
    jobId: string,
    statusOptions?: PptaskJobCallOptions,
  ): Promise<PptaskJobRecord<RESULT>> {
    throwIfAborted(statusOptions?.signal);
    let record = await ensureRecord<RESULT>(jobId);
    if (isTerminal(record.state)) return record;
    const model = options.resolveModel(record.modelType, record.modelId);

    if (record.state === 'creating' && record.operation === undefined) {
      await startRecordOnce(record, model);
      record = await ensureRecord(jobId);
      if (isTerminal(record.state)) return record;
    }
    if (!record.operation || !model.doStatus) return record;

    try {
      const status = await model.doStatus({
        operation: record.operation,
        abortSignal: statusOptions?.signal,
        headers: statusOptions?.headers,
      });
      if (status.status === 'pending') {
        const phase = 'phase' in status ? status.phase : undefined;
        const progress = 'progress' in status ? status.progress : undefined;
        const updatedAt = new Date().toISOString();
        const updated = await updateRecord(jobId, current => {
          if (isTerminal(current.state)) return current;
          return transition({
            ...current,
            state: phase === 'running' ? 'running' : 'pending',
            progress,
            error: undefined,
            updatedAt,
          }, 'progress', updatedAt);
        }) as PptaskJobRecord<RESULT>;
        reportJobEvent(updated, 'progress', { transition: 'progress' });
        return updated;
      }
      if (status.status === 'error') {
        const finishedAt = new Date().toISOString();
        const updated = await updateRecord(jobId, current => {
          if (isTerminal(current.state)) return current;
          return transition({
            ...current,
            state: 'failed',
            error: { message: status.error },
            finishedAt,
            updatedAt: finishedAt,
          }, 'failed', finishedAt);
        }) as PptaskJobRecord<RESULT>;
        reportJobEvent(updated, 'failed', { transition: 'failed' });
        return updated;
      }
      const { status: _status, ...result } = status;
      const finishedAt = new Date().toISOString();
      const updated = await updateRecord<RESULT>(jobId, current => {
        if (isTerminal(current.state)) return current;
        return transition({
          ...current,
          state: 'succeeded',
          progress: 1,
          result: result as RESULT,
          error: undefined,
          finishedAt,
          updatedAt: finishedAt,
        }, 'succeeded', finishedAt);
      });
      reportJobEvent(updated, 'succeeded', { transition: 'succeeded' });
      return updated;
    } catch (error) {
      if (isAbortError(error) || statusOptions?.signal?.aborted) throw error;
      await updateRecord(jobId, current => ({
        ...current,
        error: serializeError(error),
        updatedAt: new Date().toISOString(),
      }));
      throw error;
    }
  }

  async function* watch<RESULT>(
    jobId: string,
    watchOptions?: PptaskJobCallOptions,
  ): AsyncIterableIterator<{ type: 'state'; job: PptaskJobRecord<RESULT> }> {
    let consecutiveErrors = 0;
    while (true) {
      throwIfAborted(watchOptions?.signal);
      let job: PptaskJobRecord<RESULT>;
      try {
        job = await pollStatus<RESULT>(jobId, watchOptions);
        consecutiveErrors = 0;
      } catch (error) {
        if (isAbortError(error) || watchOptions?.signal?.aborted) throw error;
        consecutiveErrors += 1;
        if (consecutiveErrors >= options.maxStatusErrors) throw error;
        await delay(options.pollIntervalMs, watchOptions?.signal);
        continue;
      }
      yield { type: 'state', job };
      if (isTerminal(job.state)) return;
      await delay(options.pollIntervalMs, watchOptions?.signal);
    }
  }

  async function wait<RESULT>(jobId: string, waitOptions?: PptaskJobCallOptions): Promise<RESULT> {
    for await (const event of watch<RESULT>(jobId, waitOptions)) {
      const record = event.job;
      if (record.state === 'succeeded') return record.result as RESULT;
      if (record.state === 'failed') throw new Error(record.error?.message ?? `Job failed: ${jobId}`);
      if (record.state === 'cancelled') throw createAbortError(`Job cancelled: ${jobId}`);
    }
    throw new Error(`Job ended without a result: ${jobId}`);
  }

  async function updateResult<RESULT>(jobId: string, result: RESULT): Promise<PptaskJobRecord<RESULT>> {
    const updated = await updateRecord<RESULT>(jobId, current => ({ ...current, result, updatedAt: new Date().toISOString() }));
    reportJobEvent(updated, 'succeeded', { transition: 'succeeded' });
    return updated;
  }

  async function cancel(jobId: string, cancelOptions?: PptaskJobCallOptions): Promise<void> {
    throwIfAborted(cancelOptions?.signal);
    const record = await ensureRecord(jobId);
    if (isTerminal(record.state)) return;
    const model = options.resolveModel(record.modelType, record.modelId);
    if (!record.operation || !model.doCancel) {
      throw new Error(`Model does not support cancellation: ${record.modelId}`);
    }
    await model.doCancel({
      operation: record.operation,
      abortSignal: cancelOptions?.signal,
      headers: cancelOptions?.headers,
    });
    const finishedAt = new Date().toISOString();
    const updated = await updateRecord(jobId, current => {
      if (isTerminal(current.state)) return current;
      return transition({
        ...current,
        state: 'cancelled',
        finishedAt,
        updatedAt: finishedAt,
      }, 'cancelled', finishedAt);
    });
    reportJobEvent(updated, 'cancelled', { transition: 'cancelled' });
  }

  function reportJobEvent(
    record: PptaskJobRecord,
    type: 'created' | 'started' | 'progress' | 'succeeded' | 'failed' | 'cancelled',
    detail?: unknown,
  ): void {
    emitPptaskExecution(options.reporter, {
      type,
      executionId: record.id,
      jobId: record.id,
      providerId: record.providerId,
      modelType: record.modelType,
      modelId: record.modelId,
      at: record.updatedAt,
      state: record.state,
      progress: record.progress,
      detail,
      metadata: record.metadata,
      operation: record.operation,
      result: type === 'succeeded' ? record.result : undefined,
      error: type === 'failed' ? record.error : undefined,
    });
  }

  async function ensureRecord<RESULT>(jobId: string): Promise<PptaskJobRecord<RESULT>> {
    const record = await options.store.get<RESULT>(jobId);
    if (!record) throw new Error(`Job not found: ${jobId}`);
    return record;
  }

  return jobs;
}

function isTerminal(state: PptaskJobRecord['state']): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled';
}
