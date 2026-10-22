import type {
  PptaskDispatchNotifier,
  PptaskDispatchSignal,
  PptaskDispatchWakeReason,
  PptaskTaskRecord,
  PptaskTaskStore,
} from './task-store/types.js';

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_LEASE_MS = 120_000;
/** Lowest allowed recovery period: far above the old 100ms polling interval. */
export const MIN_RECOVERY_INTERVAL_MS = 5_000;
export const DEFAULT_RECOVERY_INTERVAL_MS = 30_000;
export const DEFAULT_RECOVERY_JITTER_MS = 5_000;

/**
 * In-process dispatch hints. `publish` before any subscriber keeps a bounded
 * coalesced backlog so a dispatcher created slightly later still recovers;
 * once subscribed, delivery is an edge-triggered call (never a task payload).
 */
export function createInProcessDispatchNotifier(): PptaskDispatchNotifier {
  const listeners = new Set<(signal: PptaskDispatchSignal) => void>();
  /** Signals published before the first subscriber. Coalesced by reason. */
  let backlog: PptaskDispatchSignal[] = [];
  const BACKLOG_LIMIT = 32;

  return {
    publish(signal) {
      if (listeners.size === 0) {
        if (backlog.length >= BACKLOG_LIMIT) backlog.shift();
        backlog.push(signal);
        return;
      }
      for (const listener of [...listeners]) {
        try { listener(signal); } catch { /* a listener must never break submit */ }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      if (backlog.length > 0) {
        const replay = backlog;
        backlog = [];
        for (const signal of replay) {
          try { listener(signal); } catch { /* ignore */ }
        }
      }
      return () => listeners.delete(listener);
    },
  };
}

/** Executor callback: consumes an already-claimed, fenced record. */
export type PptaskTaskExecutor = (claimed: PptaskTaskRecord) => Promise<void>;

export type PptaskDispatchMetric = {
  event:
    | 'drain'
    | 'claim-miss'
    | 'coalesced-wake'
    | 'recovery-found'
    | 'takeover'
    | 'timer-armed'
    | 'shutdown';
  reason?: PptaskDispatchWakeReason;
  durationMs?: number;
  active?: number;
  capacity?: number;
  claims?: number;
  key?: string;
};

export type PptaskDispatchCounters = {
  wakeCounts: Record<PptaskDispatchWakeReason, number>;
  coalescedWakeCount: number;
  claimQueries: number;
  claimHits: number;
  claimMisses: number;
  drainRuns: number;
  drainDurationMs: number;
  recoveryFound: number;
  takeover: number;
  active: number;
  capacity: number;
  inFlightKeys: string[];
};

export type PptaskTaskDispatcherOptions = {
  taskStore: PptaskTaskStore;
  execute: PptaskTaskExecutor;
  /** Shared with submit/cancel. Defaults to a fresh in-process notifier. */
  notifier?: PptaskDispatchNotifier;
  concurrency?: number;
  leaseMs?: number;
  recoveryIntervalMs?: number;
  recoveryJitterMs?: number;
  now?: () => Date;
  /** Injectable jitter source for deterministic tests. */
  random?: () => number;
  log?: (stage: string, details: Record<string, unknown>) => void;
  metrics?: (metric: PptaskDispatchMetric) => void;
};

export type PptaskTaskDispatcher = {
  /** Subscribe to hints and run startup recovery; call once after construction. */
  start(): void;
  /** Edge-triggered hint: "there may be work". Coalesces while draining. */
  wake(reason: PptaskDispatchWakeReason, key?: string): void;
  /** Durable retry was saved; arrange a single timer for the nearest deadline. */
  schedule(key: string, dueAt: Date): void;
  /** Durable cancel landed; drop delayed hints and re-evaluate. */
  cancel(key: string): void;
  /** Stop accepting new work and cancel recovery/delayed timers. */
  stopAccepting(): void;
  drain(): Promise<void>;
  /** Resolves when every in-flight executor has settled. */
  drained(): Promise<void>;
  stopAccepting(): void;
  close(): Promise<void>;
  counters(): PptaskDispatchCounters;
};

type DispatchCounters = {
  wakeCounts: Record<PptaskDispatchWakeReason, number>;
  coalescedWakeCount: number;
  claimQueries: number;
  claimHits: number;
  claimMisses: number;
  drainRuns: number;
  drainDurationMs: number;
  recoveryFound: number;
  takeover: number;
};

const EMPTY_WAKE_COUNTS = (): Record<PptaskDispatchWakeReason, number> => ({
  submitted: 0,
  'capacity-released': 0,
  'retry-due': 0,
  'startup-recovery': 0,
  'readiness-recovery': 0,
  'safety-sweep': 0,
  cancel: 0,
});

/**
 * Single-process task dispatcher.
 *
 * Owns the pending wake bit, executor capacity accounting, the single delayed
 * retry timer and the lifecycle. It is the *only* component that calls
 * `claimReady`; executors are passive and never touch the queue. Notifications
 * are hints — ordering, identity and state always come from the durable store.
 */
export function createPptaskTaskDispatcher(
  options: PptaskTaskDispatcherOptions,
): PptaskTaskDispatcher {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);
  const notifier = options.notifier ?? createInProcessDispatchNotifier();
  const capacity = positiveInteger(options.concurrency, DEFAULT_CONCURRENCY);
  const leaseMs = positiveInteger(options.leaseMs, DEFAULT_LEASE_MS);
  const recoveryIntervalMs = positiveInteger(
    options.recoveryIntervalMs,
    DEFAULT_RECOVERY_INTERVAL_MS,
  );
  const recoveryJitterMs = nonNegativeInteger(options.recoveryJitterMs, DEFAULT_RECOVERY_JITTER_MS);
  const random = options.random ?? Math.random;

  const counters = {
    wakeCounts: EMPTY_WAKE_COUNTS(),
    claimQueries: 0,
    claimHits: 0,
    claimMisses: 0,
    drainRuns: 0,
    drainDurationMs: 0,
    recoveryFound: 0,
    takeover: 0,
    coalescedWakeCount: 0,
  };
  const state = {
    accepting: true,
    started: false,
    draining: false,
    pendingWake: false,
    /** Reasons accumulated since the last consumed drain. */
    pendingReasons: new Set<PptaskDispatchWakeReason>(),
    inFlight: new Set<Promise<void>>(),
    inFlightKeys: new Set<string>(),
    timer: null as ReturnType<typeof setTimeout> | null,
    timerDeadline: null as number | null,
    sweepTimer: null as ReturnType<typeof setTimeout> | null,
    drainPromise: null as Promise<void> | null,
    unsubscribe: null as (() => void) | null,
  };

  const metric = (event: PptaskDispatchMetric): void => {
    try { options.metrics?.(event); } catch { /* observers must not break dispatch */ }
  };

  function clearTimer(): void {
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
    state.timerDeadline = null;
  }

  function clearSweep(): void {
    if (state.sweepTimer !== null) clearTimeout(state.sweepTimer);
    state.sweepTimer = null;
  }

  function scheduleSweep(): void {
    if (!state.accepting) return;
    const jitter = Math.floor(random() * (recoveryJitterMs + 1));
    state.sweepTimer = setTimeout(() => {
      state.sweepTimer = null;
      if (!state.accepting) return;
      wake('safety-sweep');
      scheduleSweep();
    }, recoveryIntervalMs + jitter);
    state.sweepTimer.unref?.();
  }

  function armTimerAt(atMs: number): void {
    if (!state.accepting) return;
    if (state.timerDeadline !== null && state.timerDeadline <= atMs) return;
    clearTimer();
    const delay = Math.max(0, atMs - now().getTime());
    state.timerDeadline = atMs;
    metric({ event: 'timer-armed', durationMs: delay });
    state.timer = setTimeout(() => {
      state.timer = null;
      state.timerDeadline = null;
      if (!state.accepting) return;
      wake('retry-due');
    }, delay);
    state.timer.unref?.();
  }

  async function armNextTimer(): Promise<void> {
    if (!state.accepting) return;
    let at: Date | null = null;
    try {
      at = await options.taskStore.nextWakeAt({ now: now() });
    } catch (error) {
      log('next-wake-error', { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!state.accepting) return;
    if (at === null) return; // nothing delayed; settle/notify will wake us again
    armTimerAt(at.getTime());
  }

  function consumePending(): PptaskDispatchWakeReason[] {
    const reasons = [...state.pendingReasons];
    state.pendingReasons.clear();
    state.pendingWake = false;
    return reasons;
  }

  function launch(claimed: PptaskTaskRecord): void {
    const key = claimed.key;
    state.inFlightKeys.add(key);
    const run = options.execute(claimed).catch((error) => {
      log('executor-error', { key, error: error instanceof Error ? error.message : String(error) });
    });
    state.inFlight.add(run);
    void run.finally(() => {
      state.inFlight.delete(run);
      state.inFlightKeys.delete(key);
      if (state.accepting) wake('capacity-released');
    });
  }

  /**
   * Single serial drain. Claims at most `capacity - inFlight` records, never
   * prefetching a lease the executor cannot start immediately. Re-entrant calls
   * only set the pending bit.
   */
  async function drain(): Promise<void> {
    if (state.draining) {
      state.pendingWake = true;
      return;
    }
    state.draining = true;
    const reasons = consumePending();
    const startedAt = now().getTime();
    let claims = 0;
    let isRecovery = reasons.some((reason) => reason === 'startup-recovery' || reason === 'safety-sweep');
    const run = (async () => {
      for (;;) {
        if (!state.accepting) break;
        if (state.pendingWake && state.pendingReasons.size > 0) {
          const extra = consumePending();
          // Repeated wake reasons arriving together are a coalesced wake.
          counters.coalescedWakeCount += 1;
          metric({ event: 'coalesced-wake' });
          isRecovery ||= extra.some((reason) => reason === 'startup-recovery' || reason === 'safety-sweep');
        }
        if (state.inFlight.size >= capacity) {
          // No capacity: executors will wake us on settle (`capacity-released`).
          break;
        }
        let claimed: PptaskTaskRecord | null;
        counters.claimQueries += 1;
        try {
          claimed = await options.taskStore.claimReady({
            now: now(),
            leaseUntil: new Date(now().getTime() + leaseMs),
          });
        } catch (error) {
          log('claim-error', { error: error instanceof Error ? error.message : String(error) });
          break;
        }
        if (!claimed) {
          counters.claimMisses += 1;
          metric({ event: 'claim-miss' });
          // A wake that landed while we awaited must get one more look.
          if (state.accepting && state.pendingWake) continue;
          break;
        }
        counters.claimHits += 1;
        claims += 1;
        if (isRecovery) {
          counters.recoveryFound += 1;
          metric({ event: 'recovery-found', key: claimed.key });
        }
        if (claimed.attempt > 1) {
          counters.takeover += 1;
          metric({ event: 'takeover', key: claimed.key });
        }
        launch(claimed);
      }
    })();
    state.drainPromise = run;
    try {
      await run;
    } finally {
      state.draining = false;
      state.drainPromise = null;
      const durationMs = now().getTime() - startedAt;
      counters.drainRuns += 1;
      counters.drainDurationMs += durationMs;
      metric({
        event: 'drain',
        durationMs,
        claims,
        active: state.inFlight.size,
        capacity,
      });
      // A wake that raced the end of the drain must not be lost.
      if (state.accepting && state.pendingWake) {
        queueMicrotask(() => { if (state.accepting) void drain(); });
      } else if (state.accepting) {
        await armNextTimer();
      }
    }
  }

  function wake(reason: PptaskDispatchWakeReason, _key?: string): void {
    if (!state.accepting) return;
    counters.wakeCounts[reason] += 1;
    state.pendingWake = true;
    state.pendingReasons.add(reason);
    void drain();
  }

  const dispatcher: PptaskTaskDispatcher = {
    start() {
      if (state.started) return;
      state.started = true;
      state.unsubscribe = notifier.subscribe((signal: PptaskDispatchSignal) => wake(signal.reason, signal.key));
      // Startup recovery happens once, after the store is migrated and ready.
      wake('startup-recovery');
      scheduleSweep();
    },
    wake,
    schedule(_key, dueAt) {
      if (!state.accepting) return;
      armTimerAt(dueAt.getTime());
    },
    cancel(_key) {
      // No per-key in-memory hint exists: the durable terminal status already
      // filters the next claim. Wake so a delayed timer is superseded/rearmed.
      if (!state.accepting) return;
      wake('cancel');
    },
    stopAccepting() {
      if (!state.accepting) return;
      state.accepting = false;
      clearTimer();
      clearSweep();
      state.unsubscribe?.();
      state.unsubscribe = null;
      state.pendingWake = false;
      state.pendingReasons.clear();
      metric({ event: 'shutdown', active: state.inFlight.size, capacity });
    },
    drain,
    async drained() {
      // Loop because settling executors may trigger a final drain.
      for (;;) {
        const pending = [...state.inFlight];
        if (state.drainPromise) await Promise.allSettled([state.drainPromise]);
        if (pending.length === 0 && state.inFlight.size === 0 && !state.drainPromise) return;
        await Promise.allSettled(pending);
        if (state.inFlight.size === 0 && !state.drainPromise) return;
      }
    },
    async close() {
      dispatcher.stopAccepting();
      await dispatcher.drained();
    },
    counters() {
      return {
        wakeCounts: { ...counters.wakeCounts },
        coalescedWakeCount: counters.coalescedWakeCount,
        claimQueries: counters.claimQueries,
        claimHits: counters.claimHits,
        claimMisses: counters.claimMisses,
        drainRuns: counters.drainRuns,
        drainDurationMs: counters.drainDurationMs,
        recoveryFound: counters.recoveryFound,
        takeover: counters.takeover,
        active: state.inFlight.size,
        capacity,
        inFlightKeys: [...state.inFlightKeys],
      };
    },
  };

  return dispatcher;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}
