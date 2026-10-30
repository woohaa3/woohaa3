import type { CanvasResourceCoordinator, ResidencyLease } from "./residency/index.js";

export type OverviewCacheState = "Direct" | "Queued" | "Rendering" | "Cached" | "Suspended";
export type OverviewCacheReason = "budget" | "unstable" | "dependency" | "failed" | "revoked" | "disabled" | "stale" | "overlap" | "quality" | "hidden" | "compressed-depth";

export type OverviewCacheInput = {
  ownerId: string;
  /** Complete pixel identity. Absolute canvas position is intentionally excluded. */
  fingerprint: string;
  tier: 128 | 256 | 512 | 1024 | 2048;
  bytes: number;
  /** Estimated temporary depth/MSAA/resolve bytes, released after rendering. */
  attachmentBytes?: number;
  stable: boolean;
  eligible: boolean;
  dynamic?: boolean;
  fallbackReason?: OverviewCacheReason;
};

export type OverviewCacheToken = {
  epoch: number;
  ownerId: string;
  generation: number;
  slotGeneration: number;
};

export type OverviewCacheEntry = {
  ownerId: string;
  state: OverviewCacheState;
  generation: number;
  tier: OverviewCacheInput["tier"] | null;
  fingerprint: string | null;
  reason?: OverviewCacheReason;
  queued: number;
  hits: number;
  refreshes: number;
  failures: number;
  retries: number;
  activeView: boolean;
  displayedBytes: number;
  pendingBytes: number;
  attachmentBytes: number;
};

type Entry = OverviewCacheEntry & {
  token: OverviewCacheToken | null;
  displayedFingerprint: string | null;
  displayedTier: OverviewCacheInput["tier"] | null;
  lease: Promise<unknown> | null;
  requestKey: string | null;
  displayedKey: string | null;
  displayedToken: OverviewCacheToken | null;
  nextRetryAt: number;
  retryDelayMs: number;
};

const RETRY_DELAYS_MS = [250, 1000, 4000, 15000] as const;
const increment = (value: number): number => Math.min(0xffff_ffff, value + 1);
let nextOverviewEpoch = Date.now() * 1024;

/**
 * Page-owned overview cache scheduler. It owns no pixels and never bypasses the page
 * residency coordinator; the render callback is responsible for the GPU image/plane swap.
 */
export class OverviewCacheCoordinator {
  private readonly entries = new Map<string, Entry>();
  private epoch = ++nextOverviewEpoch;
  private slotGeneration = 0;
  private refreshesThisFrame = 0;
  private activeRenders = 0;
  private readonly draining = new Map<string, number>();
  private disposed = false;
  private benchmarkDisabled = false;

  constructor(
    private readonly residency: CanvasResourceCoordinator,
    private readonly now: () => number = () => Date.now(),
    private readonly render: (input: OverviewCacheInput, token: OverviewCacheToken, lease: ResidencyLease) => Promise<unknown> = async () => { throw new Error("overview-cache-renderer-bridge-unavailable"); },
    private readonly release: (ownerId: string, token: OverviewCacheToken) => void | Promise<void> = () => undefined
  ) {}

  beginFrame(): void { this.refreshesThisFrame = 0; }
  rendererRebuilt(): void {
    if (this.disposed) return;
    for (const ownerId of this.entries.keys()) this.revoke(ownerId, "stale");
    this.epoch = ++nextOverviewEpoch;
  }
  /** Controlled comparison switch; it is diagnostic-only and never persisted as a user setting. */
  setBenchmarkDisabled(disabled: boolean): void {
    this.benchmarkDisabled = disabled;
    if (disabled) for (const ownerId of this.entries.keys()) this.revoke(ownerId, "disabled");
  }

  sync(inputs: readonly OverviewCacheInput[]): void {
    if (this.disposed) return;
    const current = new Set(inputs.map(input => input.ownerId));
    for (const ownerId of this.entries.keys()) {
      if (!current.has(ownerId)) { this.revoke(ownerId, "revoked"); this.entries.delete(ownerId); }
    }
    for (const input of inputs) this.syncOne(input);
  }

  private syncOne(input: OverviewCacheInput): void {
    let entry = this.entries.get(input.ownerId);
    if (!entry) {
      entry = this.newEntry(input.ownerId);
      this.entries.set(input.ownerId, entry);
    }
    const samePending = entry.fingerprint === input.fingerprint && entry.tier === input.tier && (entry.state === "Queued" || entry.state === "Rendering");
    entry.tier = input.tier;
    entry.activeView = input.stable && input.eligible && !input.dynamic;
    if (this.benchmarkDisabled || !input.eligible) { this.revoke(input.ownerId, this.benchmarkDisabled ? "disabled" : input.fallbackReason ?? "disabled"); return; }
    if (!input.stable || input.dynamic) {
      this.revoke(input.ownerId, "unstable");
      return;
    }
    if (entry.displayedFingerprint === input.fingerprint && entry.displayedTier === input.tier && entry.state === "Cached") {
      entry.hits = increment(entry.hits);
      return;
    }
    if (samePending) return;
    this.cancelPending(entry);
    if (entry.nextRetryAt > this.now()) return;
    if (this.activeRenders > 0 || [...this.entries.values()].some(other => other !== entry && (other.state === "Queued" || other.state === "Rendering"))) {
      entry.state = "Suspended";
      entry.reason = "budget";
      return;
    }
    if (this.refreshesThisFrame >= Math.min(1, Math.floor(this.residency.getPolicy().previewRefreshesPerFrame))) {
      entry.state = "Suspended";
      entry.reason = "budget";
      entry.pendingBytes = 0;
      return;
    }
    this.queue(input, entry);
  }

  private queue(input: OverviewCacheInput, entry: Entry): void {
    this.slotGeneration += 1;
    entry.generation += 1;
    const key = `overview-cache:${this.epoch}:${this.slotGeneration}:${input.ownerId}`;
    const attachments = input.attachmentBytes ?? 0;
    const reservedBytes = input.bytes + attachments;
    if (!Number.isFinite(input.bytes) || input.bytes <= 0 || !Number.isFinite(attachments) || attachments < 0
      || !this.residency.reserveDerivedGpu(key, reservedBytes, input.ownerId, () => this.revoke(input.ownerId, "budget"))) {
      entry.state = "Suspended";
      entry.reason = "budget";
      return;
    }
    this.refreshesThisFrame += 1;
    entry.fingerprint = input.fingerprint;
    entry.pendingBytes = reservedBytes;
    entry.attachmentBytes = attachments;
    entry.state = "Queued";
    entry.reason = undefined;
    entry.queued = increment(entry.queued);
    const token: OverviewCacheToken = { epoch: this.epoch, ownerId: input.ownerId, generation: entry.generation, slotGeneration: this.slotGeneration };
    entry.token = token;
    entry.requestKey = key;
    let started = false;
    let retained = false;
    const run = this.residency.admit({
      channel: "preview",
      key,
      purpose: "visible",
      bytes: reservedBytes,
      abortable: false,
      run: async ({ lease }) => {
        const current = this.entries.get(input.ownerId);
        if (current?.token !== token || current.state !== "Queued") return;
        started = true;
        current.state = "Rendering";
        this.activeRenders += 1;
        try {
          await this.render(input, token, lease);
          const completed = this.entries.get(input.ownerId);
          if (lease.signal.aborted || completed?.token !== token || completed.state !== "Rendering") return;
          this.residency.reduceDerivedGpu(key, input.bytes);
          if (completed.displayedKey) this.residency.releaseDerivedGpu(completed.displayedKey);
          retained = true;
          completed.displayedKey = key;
          completed.displayedToken = token;
          completed.state = "Cached";
          completed.displayedFingerprint = input.fingerprint;
          completed.displayedTier = input.tier;
          completed.displayedBytes = input.bytes;
          completed.pendingBytes = 0;
          completed.attachmentBytes = 0;
          completed.refreshes = increment(completed.refreshes);
          completed.retryDelayMs = RETRY_DELAYS_MS[0];
          completed.retries = 0;
        } finally {
          this.activeRenders -= 1;
          this.draining.delete(key);
          if (!retained) this.residency.releaseDerivedGpu(key);
        }
      }
    });
    entry.lease = run;
    void run.then(outcome => {
      if (!started) this.residency.releaseDerivedGpu(key);
      const current = this.entries.get(input.ownerId);
      if (!current || current.token !== token || current.state === "Cached") return;
      if (outcome.status === "cancelled") return;
      current.state = current.displayedFingerprint ? "Cached" : "Direct";
      current.reason = "failed";
      current.failures = increment(current.failures);
      current.retries = increment(current.retries);
      current.nextRetryAt = this.now() + current.retryDelayMs;
      current.retryDelayMs = RETRY_DELAYS_MS[Math.min(RETRY_DELAYS_MS.length - 1, current.retries)] ?? RETRY_DELAYS_MS.at(-1)!;
      current.pendingBytes = 0;
      current.attachmentBytes = 0;
    });
  }

  private newEntry(ownerId: string): Entry {
    return { ownerId, state: "Direct", generation: 0, tier: null, fingerprint: null, queued: 0, hits: 0, refreshes: 0, failures: 0, retries: 0, activeView: false, displayedBytes: 0, pendingBytes: 0, attachmentBytes: 0, token: null, requestKey: null, displayedKey: null, displayedToken: null, displayedFingerprint: null, displayedTier: null, lease: null, nextRetryAt: 0, retryDelayMs: RETRY_DELAYS_MS[0] };
  }

  private cancelPending(entry: Entry): void {
    if (entry.state !== "Queued" && entry.state !== "Rendering") return;
    if (entry.state === "Rendering" && entry.requestKey) this.draining.set(entry.requestKey, entry.pendingBytes);
    entry.token = null;
    if (entry.requestKey) this.residency.cancel(entry.requestKey);
    entry.requestKey = null;
    entry.pendingBytes = 0;
    entry.attachmentBytes = 0;
    entry.state = entry.displayedFingerprint ? "Cached" : "Direct";
  }

  revoke(ownerId: string, reason: OverviewCacheReason = "revoked"): void {
    const entry = this.entries.get(ownerId);
    if (!entry) return;
    this.cancelPending(entry);
    if (entry.displayedKey && entry.displayedToken) {
      const key = entry.displayedKey;
      try {
        const result = this.release(ownerId, entry.displayedToken);
        if (result) void result.then(() => this.residency.releaseDerivedGpu(key), () => undefined);
        else this.residency.releaseDerivedGpu(key);
      } catch {
        // Retain the reservation when the renderer cannot confirm release.
      }
      entry.displayedKey = null;
      entry.displayedToken = null;
    }
    entry.token = null;
    entry.state = "Direct";
    entry.reason = reason;
    entry.activeView = false;
    entry.fingerprint = null;
    entry.pendingBytes = 0;
    entry.attachmentBytes = 0;
    entry.displayedFingerprint = null;
    entry.displayedTier = null;
    entry.displayedBytes = 0;
  }

  diagnostics(): { epoch: number; activeViews: number; displayedBytes: number; pendingBytes: number; drainingBytes: number; attachmentBytes: number; entries: OverviewCacheEntry[] } {
    const entries = [...this.entries.values()].map(({ token: _token, lease: _lease, requestKey: _requestKey, displayedKey: _displayedKey, displayedToken: _displayedToken, displayedFingerprint: _displayedFingerprint, displayedTier: _displayedTier, nextRetryAt: _nextRetryAt, retryDelayMs: _retryDelayMs, ...entry }) => ({ ...entry }));
    return { epoch: this.epoch, activeViews: this.activeRenders, displayedBytes: entries.reduce((total, entry) => total + entry.displayedBytes, 0), pendingBytes: entries.reduce((total, entry) => total + entry.pendingBytes, 0), drainingBytes: [...this.draining.values()].reduce((total, bytes) => total + bytes, 0), attachmentBytes: entries.reduce((total, entry) => total + entry.attachmentBytes, 0), entries };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch += 1;
    for (const entry of this.entries.values()) this.revoke(entry.ownerId);
    this.entries.clear();
  }
}
