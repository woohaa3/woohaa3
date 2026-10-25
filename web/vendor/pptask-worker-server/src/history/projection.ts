import {
  subscribePptaskExecutions,
  type PptaskExecutionEvent,
  type PptaskModelType,
  type PptaskSchedulingEvent,
} from '@sdppp/pptask';
import {
  createMemoryExecutionHistoryRepository,
  type ExecutionHistoryRepository,
} from './repository.js';

export type ExecutionOutput = {
  kind: 'image' | 'video' | 'audio' | 'file' | 'text' | 'data';
  label?: string;
  url?: string;
  mediaType?: string;
  text?: string;
};

export type ExecutionResult = { outputCount: number; outputs: ExecutionOutput[]; value: unknown };
/**
 * Terminal-accurate snapshot of the whole flow. `queued` is scheduling-only
 * (enqueued, not claimed yet); the rest mirror the job's execution state.
 */
export type ExecutionState = 'queued' | 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
/** Scheduling phases come from the worker; execution phases come from the job engine. */
export type ExecutionEventKind = 'scheduling' | 'execution';
export type ExecutionEvent = { at: string; stage: string; kind?: ExecutionEventKind; detail?: unknown };

export type ExecutionRecord<RESULT = unknown> = {
  id: string;
  jobId?: string;
  providerId: string;
  /** Undefined only for records created from scheduling events before any job event arrived. */
  modelType?: PptaskModelType;
  modelId?: string;
  state: ExecutionState;
  progress?: number;
  taskId?: string;
  metadata?: Record<string, unknown>;
  events: ExecutionEvent[];
  /** Accumulated stream text for streaming executions (deltas merge here). */
  streamedText?: string;
  /** Total claim rounds observed from scheduling events. */
  attempt?: number;
  /** Last scheduling-side retry budget snapshot. */
  consecutiveFailures?: number;
  result?: ExecutionResult;
  error?: { name?: string; message: string; stack?: string; status?: number; code?: string };
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
  durationMs: number;
};

export type PptaskExecutionHistory = {
  get(id: string): Promise<ExecutionRecord | undefined>;
  list(): Promise<ExecutionRecord[]>;
  subscribe(listener: (record: ExecutionRecord) => void): () => void;
  /** Ingests a worker scheduling fact into the projection. Reporting never alters scheduling. */
  ingestSchedulingEvent(event: PptaskSchedulingEvent): void;
  /** Resolves after queued storage writes complete, and rejects if one failed. */
  flush(): Promise<void>;
  dispose(): Promise<void>;
};

export type CreatePptaskExecutionHistoryOptions = {
  maxRecords?: number;
  maxEventsPerRecord?: number;
  now?: () => number;
  repository?: ExecutionHistoryRepository<ExecutionRecord>;
};

/** Projects Pptask execution events without owning execution or job state. */
export async function createPptaskExecutionHistory(
  options: CreatePptaskExecutionHistoryOptions = {},
): Promise<PptaskExecutionHistory> {
  const now = options.now ?? Date.now;
  const maxRecords = options.maxRecords ?? 300;
  const maxEventsPerRecord = options.maxEventsPerRecord ?? 200;
  const repository = options.repository ?? createMemoryExecutionHistoryRepository<ExecutionRecord>();
  const stored = await repository.list({ limit: maxRecords });
  const records = new Map(stored.records.map(record => [record.id, record]));
  const listeners = new Set<(record: ExecutionRecord) => void>();
  let disposed = false;
  let writes = Promise.resolve();
  let writeFailure: unknown;

  const publish = (record: ExecutionRecord): void => {
    for (const listener of listeners) {
      try { listener(record); } catch { /* observer failures must not affect Pptask */ }
    }
  };
  const enqueue = (operation: () => Promise<void>) => {
    writes = writes.then(operation).catch(error => {
      writeFailure ??= error;
    });
  };
  const applyExecution = async (event: PptaskExecutionEvent): Promise<void> => {
    if (disposed || !event.executionId) return;
    // Jobs submitted through the worker carry their task key in metadata, so
    // execution phases merge into the same record as scheduling phases.
    const metadataKey = event.metadata && typeof (event.metadata as Record<string, unknown>).taskKey === 'string'
      ? (event.metadata as Record<string, unknown>).taskKey as string
      : undefined;
    const recordId = metadataKey ?? event.executionId;
    const previous = records.get(recordId);
    const terminalEvent = event.type === 'succeeded' || event.type === 'failed' || event.type === 'cancelled';

    // Stream-mode delta facts accumulate into `streamedText` instead of
    // flooding the event log; the record update itself is the push channel.
    const detail = event.detail && typeof event.detail === 'object' ? event.detail as Record<string, unknown> : undefined;
    const deltaText = event.type === 'progress' && detail?.phase === 'delta' && typeof detail.text === 'string'
      ? detail.text
      : undefined;
    const streamedText = deltaText !== undefined
      ? (previous?.streamedText ?? '') + deltaText
      : previous?.streamedText;

    const state = eventState(event);
    const startedAt = previous?.startedAt ?? (event.type === 'started' ? event.at : undefined);
    const finishedAt = terminalEvent ? event.at : previous?.finishedAt;
    const result = event.result === undefined
      ? previous?.result
      : extractExecutionResult(event.result);
    const record: ExecutionRecord = {
      id: recordId,
      jobId: event.jobId ?? previous?.jobId,
      providerId: event.providerId,
      modelType: event.modelType,
      modelId: event.modelId,
      state,
      progress: event.progress ?? previous?.progress,
      taskId: operationTaskId(event.operation) ?? operationTaskId(event.detail && typeof event.detail === 'object' ? (event.detail as Record<string, unknown>).operation : undefined) ?? previous?.taskId,
      metadata: event.metadata ?? previous?.metadata,
      // Delta facts accumulate into `streamedText`; they do not flood the
      // event log (milestones only).
      events: deltaText !== undefined
        ? previous?.events ?? []
        : [...(previous?.events ?? []), executionEvent(event)].slice(-maxEventsPerRecord),
      streamedText,
      attempt: previous?.attempt,
      consecutiveFailures: previous?.consecutiveFailures,
      result,
      error: event.error ?? (terminalEvent ? previous?.error : undefined),
      createdAt: previous?.createdAt ?? event.at,
      startedAt,
      updatedAt: event.at,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt ?? new Date(now()).toISOString()) - Date.parse(startedAt ?? event.at)),
    };
    records.set(record.id, record);
    enqueue(() => repository.upsert(record));
    const removed = trim(records, maxRecords);
    for (const id of removed) enqueue(() => repository.delete(id));
    publish(record);
  };
  const applyScheduling = (event: PptaskSchedulingEvent): void => {
    if (disposed || !event.jobId) return;
    const previous = records.get(event.jobId);
    const schedulingTerminal = event.stage === 'task-completed'
      ? 'succeeded' as const
      : event.stage === 'task-failed'
        ? 'failed' as const
        : event.stage === 'task-cancelled'
          ? 'cancelled' as const
          : undefined;
    const executionWasTerminal = previous !== undefined
      && (previous.state === 'succeeded' || previous.state === 'failed' || previous.state === 'cancelled');
    // Scheduling may set the initial `queued` state and settle terminal
    // outcomes, but never overrides an execution-side terminal state.
    const sourceBlocked = !!(event.detail && typeof event.detail === 'object' && (event.detail as Record<string, unknown>).sourceStale);
    const state: ExecutionState = sourceBlocked && !executionWasTerminal ? 'pending' : previous === undefined
      ? 'queued'
      : schedulingTerminal && !executionWasTerminal
        ? schedulingTerminal
        : previous.state;
    const finishedAt = schedulingTerminal && !executionWasTerminal
      ? event.at
      : previous?.finishedAt;
    // 调度侧的失败原因（worker 把 drive 的错误放进 detail.message）要落到记录上，
    // 否则执行历史与画布只能看到「失败」，看不到原因。
    const schedulingMessage = event.detail && typeof event.detail === 'object'
      && typeof (event.detail as Record<string, unknown>).message === 'string'
      ? (event.detail as Record<string, unknown>).message as string
      : undefined;
    const attempt = Math.max(previous?.attempt ?? 0, event.attempt ?? 0);
    const record: ExecutionRecord = {
      id: event.jobId,
      jobId: previous?.jobId ?? event.jobId,
      providerId: previous?.providerId ?? event.providerId,
      modelType: previous?.modelType,
      modelId: previous?.modelId,
      state,
      progress: previous?.progress,
      taskId: previous?.taskId,
      metadata: previous?.metadata,
      events: [...(previous?.events ?? []), {
        at: event.at,
        stage: `worker.${event.stage}`,
        kind: 'scheduling' as const,
        detail: {
          ...(event.detail && typeof event.detail === 'object' ? event.detail as Record<string, unknown> : event.detail === undefined ? {} : { detail: event.detail }),
          attempt: event.attempt,
          consecutiveFailures: event.consecutiveFailures,
        },
      }].slice(-maxEventsPerRecord),
      streamedText: previous?.streamedText,
      attempt: attempt > 0 ? attempt : previous?.attempt,
      consecutiveFailures: event.consecutiveFailures ?? previous?.consecutiveFailures,
      result: previous?.result,
      error: previous?.error
        ?? ((schedulingTerminal === 'failed' || sourceBlocked) && schedulingMessage !== undefined
          ? { message: schedulingMessage }
          : undefined),
      createdAt: previous?.createdAt ?? event.at,
      startedAt: previous?.startedAt,
      updatedAt: event.at,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt ?? new Date(now()).toISOString()) - Date.parse(previous?.startedAt ?? previous?.createdAt ?? event.at)),
    };
    records.set(record.id, record);
    enqueue(() => repository.upsert(record));
    const removed = trim(records, maxRecords);
    for (const id of removed) enqueue(() => repository.delete(id));
    publish(record);
  };

  const executionUnsubscribe = subscribePptaskExecutions(event => {
    void applyExecution(event);
  });

  return {
    get: async id => records.get(id),
    list: async () => [...records.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    ingestSchedulingEvent: applyScheduling,
    async flush() {
      await writes;
      if (writeFailure) throw writeFailure;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      executionUnsubscribe();
      listeners.clear();
      await writes;
      if (writeFailure) throw writeFailure;
    },
  };
}

function eventState(event: PptaskExecutionEvent): ExecutionState {
  if (event.type === 'created') return 'pending';
  if (event.type === 'started') return 'running';
  if (event.type === 'succeeded') return 'succeeded';
  if (event.type === 'failed') return 'failed';
  if (event.type === 'cancelled') return 'cancelled';
  if (event.state === 'running') return 'running';
  if (event.state === 'pending') return 'pending';
  return 'running';
}

function executionEvent(event: PptaskExecutionEvent): ExecutionEvent {
  const detail = event.detail === undefined && event.progress === undefined && event.state === undefined
    ? undefined
    : { ...(event.detail && typeof event.detail === 'object' ? event.detail as Record<string, unknown> : { detail: event.detail }), progress: event.progress, state: event.state };
  const transition = event.detail && typeof event.detail === 'object' && typeof (event.detail as Record<string, unknown>).transition === 'string'
    ? (event.detail as Record<string, unknown>).transition as string
    : undefined;
  return { at: event.at, stage: `pptask.${transition ?? event.type}`, kind: 'execution' as const, detail };
}

export const createExecutionHistory = createPptaskExecutionHistory;
export type ExecutionHistory = PptaskExecutionHistory;
export * from './repository.js';

export function extractExecutionResult(value: unknown): ExecutionResult {
  const extracted = outputs(value);
  return { outputCount: extracted.length, outputs: extracted, value: display(value) };
}

function operationTaskId(operation: unknown): string | undefined {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return undefined;
  const value = operation as Record<string, unknown>;
  for (const key of ['taskId', 'task_id', 'id', 'name']) {
    if (typeof value[key] === 'string' && value[key]) return value[key];
  }
  return undefined;
}

function trim(records: Map<string, unknown>, max: number): string[] {
  const removed: string[] = [];
  while (records.size > max) {
    const id = [...records.entries()].reduce((oldest, entry) => (
      (entry[1] as ExecutionRecord).createdAt.localeCompare((oldest[1] as ExecutionRecord).createdAt) < 0
        ? entry
        : oldest
    ))[0];
    records.delete(id);
    removed.push(id);
  }
  return removed;
}

function outputs(value: unknown): ExecutionOutput[] {
  if (typeof value === 'string') return [{ kind: 'text', text: value }];
  if (!value || typeof value !== 'object') return [];
  const source = value as Record<string, unknown>;
  if (Array.isArray(source.content)) {
    const contentOutputs = source.content.flatMap((item, index) => languageContentOutput(item, index));
    if (contentOutputs.length) return contentOutputs;
  }
  // Audio results carry their payload under `audios`/`audio`, which neither
  // the text nor the image/video candidates below would pick up.
  if (Array.isArray(source.audios) || source.audio !== undefined) {
    return audioOutputs(source);
  }
  const text = languageText(value);
  if (text !== undefined) return [{ kind: 'text', label: '文本', text }];
  const defaultKind = Array.isArray(source.images) ? 'image' : Array.isArray(source.videos) ? 'video' : undefined;
  const candidates = Array.isArray(source.outputs) ? source.outputs : Array.isArray(source.images) ? source.images : Array.isArray(source.videos) ? source.videos : [];
  const providerUrls = providerImageUrls(source.providerMetadata);
  return candidates.flatMap((item, index): ExecutionOutput[] => {
    if (typeof item === 'string') return [urlOutput(item, undefined, index)];
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) {
      return providerUrls[index]
        ? [urlOutput(providerUrls[index], defaultKind === 'image' ? 'image/*' : undefined, index)]
        : [{ kind: defaultKind ?? 'data', label: `输出 ${index + 1}`, text: binary(item) }];
    }
    if (!item || typeof item !== 'object') return [];
    const output = item as Record<string, unknown>;
    const mediaType = typeof output.mediaType === 'string' ? output.mediaType : undefined;
    if (typeof output.url === 'string') return [urlOutput(output.url, mediaType, index)];
    if (typeof output.text === 'string') return [{ kind: 'text', label: `输出 ${index + 1}`, text: output.text }];
    if (output.data !== undefined) return [{ kind: mediaType ? mediaKind(mediaType) : defaultKind ?? 'data', label: `输出 ${index + 1}`, mediaType, text: binary(output.data) }];
    return [{ kind: 'data', label: `输出 ${index + 1}`, text: JSON.stringify(display(output)) }];
  });
}

/**
 * Audio results are shaped as `{ audio, audios }` (a pptask extension over the
 * AI SDK's speech result). Unlike text there is no intrinsic marker telling a
 * base64 payload apart from prose, so membership is decided by the key.
 */
function audioOutputs(source: Record<string, unknown>): ExecutionOutput[] {
  const raw = source.audios ?? source.audio;
  const items = Array.isArray(raw) ? raw : [raw];
  return items.flatMap((item, index): ExecutionOutput[] => {
    const label = `输出 ${index + 1}`;
    if (typeof item === 'string') {
      if (/^https?:\/\//.test(item)) return [urlOutput(item, undefined, index)];
      return [{ kind: 'audio', label, mediaType: dataUrlMediaType(item), text: audioText(item) }];
    }
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) {
      return [{ kind: 'audio', label, text: binary(item) }];
    }
    if (!item || typeof item !== 'object') return [];
    const output = item as Record<string, unknown>;
    const mediaType = typeof output.mediaType === 'string' ? output.mediaType : undefined;
    if (typeof output.url === 'string') return [urlOutput(output.url, mediaType, index)];
    if (output.data !== undefined) return [{ kind: 'audio', label, mediaType, text: binary(output.data) }];
    if (typeof output.text === 'string') return [{ kind: 'audio', label, mediaType, text: output.text }];
    return [{ kind: 'audio', label, mediaType, text: JSON.stringify(display(output)) }];
  });
}

function dataUrlMediaType(value: string): string | undefined {
  return /^data:([^;,]+)[;,]/.exec(value)?.[1];
}

function audioText(value: string): string {
  const payload = /^data:[^;,]+;base64,(.*)$/s.exec(value)?.[1] ?? value;
  return `[audio ${payload.length} base64 chars]`;
}

function languageContentOutput(value: unknown, index: number): ExecutionOutput[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const content = value as Record<string, unknown>;
  const type = typeof content.type === 'string' ? content.type : undefined;
  if ((type === 'text' || type === 'reasoning') && typeof content.text === 'string') {
    return [{ kind: 'text', label: type === 'reasoning' ? `推理 ${index + 1}` : `文本 ${index + 1}`, text: content.text }];
  }
  if (type === 'file' && content.data !== undefined) {
    const mediaType = typeof content.mediaType === 'string' ? content.mediaType : undefined;
    return [{ kind: mediaType ? mediaKind(mediaType) : 'file', label: `文件 ${index + 1}`, mediaType, text: binary(content.data) }];
  }
  if (type === 'tool-call' || type === 'tool-result' || type === 'source') {
    return [{ kind: 'data', label: `${type} ${index + 1}`, text: JSON.stringify(display(content)) }];
  }
  return typeof content.text === 'string'
    ? [{ kind: 'text', label: `文本 ${index + 1}`, text: content.text }]
    : [];
}

function languageText(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  for (const key of ['text', 'output_text']) {
    if (typeof source[key] === 'string') return source[key] as string;
  }
  if (Array.isArray(source.choices)) {
    const texts = source.choices.flatMap(choice => {
      if (!choice || typeof choice !== 'object') return [];
      const item = choice as Record<string, unknown>;
      const message = item.message && typeof item.message === 'object' ? item.message as Record<string, unknown> : undefined;
      const text = item.text ?? message?.content;
      return typeof text === 'string' ? [text] : [];
    });
    if (texts.length) return texts.join('');
  }
  return undefined;
}

function providerImageUrls(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>).flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const images = (item as Record<string, unknown>).images;
    if (!Array.isArray(images)) return [];
    return images.flatMap(image => image && typeof image === 'object' && typeof (image as Record<string, unknown>).url === 'string'
      ? [(image as Record<string, unknown>).url as string]
      : []);
  });
}

function urlOutput(url: string, mediaType: string | undefined, index: number): ExecutionOutput { return { kind: mediaKind(mediaType, url), label: `输出 ${index + 1}`, url, mediaType }; }
function mediaKind(mediaType?: string, url?: string): ExecutionOutput['kind'] {
  const hint = `${mediaType ?? ''} ${url ?? ''}`.toLowerCase();
  if (hint.includes('image') || /\.(avif|gif|jpe?g|png|svg|webp)(?:[?#]|$)/.test(hint)) return 'image';
  if (hint.includes('video') || /\.(avi|m4v|mov|mp4|webm)(?:[?#]|$)/.test(hint)) return 'video';
  if (hint.includes('audio') || /\.(m4a|mp3|ogg|wav)(?:[?#]|$)/.test(hint)) return 'audio';
  return 'file';
}
function display(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'undefined') return undefined;
  if (typeof value === 'function' || typeof value === 'symbol') return String(value);
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return value.toString();
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return binary(value);
  if (typeof Blob !== 'undefined' && value instanceof Blob) return `[blob ${value.type || 'application/octet-stream'}, ${value.size} bytes]`;
  if (depth >= 8) return '[max depth]';
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);
  const result = Array.isArray(value) ? value.map(item => display(item, seen, depth + 1)) : Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    const shown = display(item, seen, depth + 1); return shown === undefined ? [] : [[key, shown]];
  }));
  seen.delete(value as object);
  return result;
}
function binary(value: unknown): string { return ArrayBuffer.isView(value) ? `[binary ${value.byteLength} bytes]` : value instanceof ArrayBuffer ? `[binary ${value.byteLength} bytes]` : '[binary data]'; }
