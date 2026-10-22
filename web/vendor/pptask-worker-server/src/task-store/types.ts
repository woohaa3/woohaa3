/**
 * Scheduling status of a worker task. It tracks *who runs the task and when*,
 * never the outcome itself — the outcome lives in `result` / provider state.
 *
 * `submitting` means the task claims an idempotency key but the execution has not
 * started the execution yet (the crash window between claim and `start`).
 */
export type PptaskTaskStatus =
  | 'submitting'
  | 'queued'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * The single durable record of a managed execution. Primary key is the
 * idempotency key of the submission; `state` carries the provider-owned
 * recovery snapshot.
 *
 * `context` is opaque business context (tenant ids, owners, correlation
 * ids) passed through to the provider execution. NEVER store credentials here — the
 * record is durable and may be broadly readable.
 */
export type PptaskTaskRecord = {
  key: string;
  providerId: string;
  /** Engine-interpreted submission snapshot; used to (re)start the execution. */
  params?: unknown;
  /** Opaque business context passed through to the provider execution. */
  context?: unknown;
  /** Engine-owned recovery snapshot, updated live while driving. */
  state?: unknown;
  /** Display-safe result. Heavy payloads belong to application storage. */
  result?: unknown;
  /** Observability only. */
  ownerId?: string;
  status: PptaskTaskStatus;
  /** Regenerated on every claim and cancel; fences writes from stale claimants. */
  claimToken?: string;
  leaseUntil?: Date;
  /** Backoff target. Undefined means due now. */
  nextRunAt?: Date;
  /** Total claim rounds. Observability only. */
  attempt: number;
  /** Mirror of the worker's in-process retry budget. Observability only. */
  consecutiveFailures: number;
  createdAt: Date;
  updatedAt: Date;
};

export type PptaskTaskSubmitInput = {
  key: string;
  providerId: string;
  params?: unknown;
  context?: unknown;
  ownerId?: string;
  /** Adopt an existing provider execution: the task starts as `queued`. */
  state?: unknown;
  now: Date;
};

export type PptaskTaskClaim = {
  now: Date;
  leaseUntil: Date;
};

/**
 * Scheduling-classification of a durable task. The dispatcher uses it to tell
 * "work I can claim right now" (ready) from "work that becomes claimable later"
 * (delayed) and "work parked until a lease expires" (takeover).
 *
 * The classification is always derived from the durable record — never from an
 * in-memory queue.
 */
export type PptaskTaskDispatchState = 'ready' | 'delayed' | 'executing' | 'terminal';

export function classifyTaskDispatchState(
  record: PptaskTaskRecord,
  now: Date,
): PptaskTaskDispatchState {
  if (isTaskTerminal(record.status)) return 'terminal';
  if (record.status === 'executing') {
    return record.leaseUntil && record.leaseUntil <= now ? 'ready' : 'executing';
  }
  // submitting | queued
  return !record.nextRunAt || record.nextRunAt <= now ? 'ready' : 'delayed';
}

export function isTaskTerminal(status: PptaskTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * Durable store for worker tasks — the single persistence layer of the
 * managed runtime. The reference implementation is in-memory and
 * single-process; database implementations must guarantee:
 *
 * - `submit`: atomic create-if-absent on `key` (unique index + INSERT ON
 *   CONFLICT). Returns the existing record unchanged when present.
 * - `claimReady`: atomic claim of exactly one ready task — `submitting`/`queued`
 *   with `nextRunAt <= now`, or `executing` with an expired lease (takeover).
 *   Postgres: `SELECT ... FOR UPDATE SKIP LOCKED` over the ready predicate.
 * - `nextWakeAt`: earliest *future* deadline the dispatcher must wake for:
 *   the smallest future `nextRunAt` of a non-terminal task, or the smallest
 *   future lease deadline of an executing task. Never a fixed-frequency poll.
 * - `heartbeat` / `save`: fenced by `claimToken`; a stale claimant's writes
 *   must be ignored (`WHERE claim_token = $token`).
 * - `cancel`: terminal statuses win; rotates the claim token.
 *
 * `claimDue` is the pre-dispatcher name of `claimReady`; it is kept as a
 * deprecated compatibility alias and must stay behaviourally identical.
 */
export type PptaskTaskStore = {
  submit(input: PptaskTaskSubmitInput): Promise<{ record: PptaskTaskRecord; created: boolean }>;
  find(key: string): Promise<PptaskTaskRecord | null>;
  /** Atomically claim one ready task in stable queue order. */
  claimReady(input: PptaskTaskClaim): Promise<PptaskTaskRecord | null>;
  /** Earliest future deadline to schedule a single dispatch timer for. */
  nextWakeAt(input: { now: Date }): Promise<Date | null>;
  /** @deprecated Use `claimReady`; kept for pre-dispatcher callers. */
  claimDue(input: PptaskTaskClaim): Promise<PptaskTaskRecord | null>;
  heartbeat(input: {
    key: string;
    claimToken: string;
    leaseUntil: Date;
    now: Date;
  }): Promise<boolean>;
  save(record: PptaskTaskRecord): Promise<void>;
  cancel(key: string, now: Date): Promise<PptaskTaskRecord | null>;
  /** Optional push feed for status/SSE. Absent → hosts poll `find`. */
  subscribe?(listener: (record: PptaskTaskRecord) => void): () => void;
};

/** Why the dispatcher was woken. Notifications are hints, never task payload. */
export type PptaskDispatchWakeReason =
  | 'submitted'
  | 'capacity-released'
  | 'retry-due'
  | 'startup-recovery'
  | 'readiness-recovery'
  | 'safety-sweep'
  | 'cancel';

/**
 * The only thing that crosses the notification boundary. It carries no task
 * payload and no completion fact — consumers read those from the durable store.
 */
export type PptaskDispatchSignal = {
  reason: PptaskDispatchWakeReason;
  /** Optional hint; claim order is still owned by the store. */
  key?: string;
};

/**
 * Transport for dispatch hints. The single-process implementation is an
 * in-process emitter; multi-instance deployments swap it for Redis pub/sub or
 * Postgres LISTEN/NOTIFY while the durable store remains the source of truth.
 */
export type PptaskDispatchNotifier = {
  publish(signal: PptaskDispatchSignal): void | Promise<void>;
  subscribe(listener: (signal: PptaskDispatchSignal) => void): () => void;
};
