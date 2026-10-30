import type { BevyRuntime } from "./bevy-runtime-types.js";
import type { CanvasResourceCoordinator, ResidencyLease } from "./residency/index.js";
import type { OverviewCacheCoordinator, OverviewCacheInput, OverviewCacheToken } from "./overview-cache.js";
import { activeTelemetryClient, telemetryBuildMode } from "../../services/telemetry-primitives.js";
import { readOverviewLodDistribution } from "./overview-lod-telemetry.js";

type Result = { owner: string; generation: number; epoch: number; success: boolean; cancelled: boolean };
type Release = { owner: string; epoch: number; requestId: number };
type Snapshot = { candidates: Array<OverviewCacheInput & { reason?: string | null; modelDeclared?: boolean; modelReady?: boolean; mediaDeclared?: number; mediaReady?: boolean }>; results: Result[]; releases: Release[] };
type Pending = { resolve: () => void; reject: (error: Error) => void; signal: AbortSignal; onAbort: () => void };

function fallbackReason(reason: string | null | undefined): OverviewCacheInput["fallbackReason"] {
  switch (reason) {
    case "Dynamic": return "unstable";
    case "Dependencies": return "dependency";
    case "Overlap": return "overlap";
    case "Quality": return "quality";
    case "Hidden": return "hidden";
    case "CompressedDepth": return "compressed-depth";
    default: return "disabled";
  }
}

/** Control bridge only. Images stay in the renderer; terminal feedback settles page leases. */
export class OverviewCacheBridge {
  private coordinator: OverviewCacheCoordinator | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly releases = new Map<number, { owner: string; epoch: number; resolve: () => void; reject: (error: Error) => void }>();
  private nextRelease = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private waitingDependencies = false;
  private retryIndex = 0;
  private rendererGeneration: number;
  private lastTelemetry = "";
  private lastTelemetryAt = 0;

  constructor(private readonly runtime: BevyRuntime, private readonly residency: CanvasResourceCoordinator,
    private readonly isDynamic: (owner: string) => boolean = () => false) {
    this.rendererGeneration = runtime.generation?.() ?? 0;
  }
  connect(coordinator: OverviewCacheCoordinator): void { this.coordinator = coordinator; }

  render = (input: OverviewCacheInput, token: OverviewCacheToken, lease: ResidencyLease): Promise<void> => {
    if (this.disposed || !this.runtime.overviewCacheCommand) return Promise.reject(new Error("overview-cache-renderer-bridge-unavailable"));
    const key = this.key(token.ownerId, token.epoch, token.generation);
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        try { this.command({ kind: "cancel", owner: token.ownerId, epoch: token.epoch, generation: token.generation }); }
        catch { /* Keep the lease draining until renderer destruction or terminal feedback. */ }
      };
      this.pending.set(key, { resolve, reject, signal: lease.signal, onAbort });
      lease.signal.addEventListener("abort", onAbort, { once: true });
      try {
        this.command({ kind: "render", owner: input.ownerId, fingerprint: input.fingerprint, epoch: token.epoch, generation: token.generation });
        if (lease.signal.aborted) onAbort();
        this.schedule();
      } catch (error) {
        this.pending.delete(key);
        lease.signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  release = (owner: string, token: OverviewCacheToken): Promise<void> => {
    if (this.disposed) return Promise.reject(new Error("overview-cache-renderer-disposed"));
    const requestId = ++this.nextRelease;
    return new Promise<void>((resolve, reject) => {
      this.releases.set(requestId, { owner, epoch: token.epoch, resolve, reject });
      try {
        this.command({ kind: "release", owner, epoch: token.epoch, generation: token.generation, requestId });
        this.schedule();
      } catch (error) {
        this.releases.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  frame(): void {
    if (this.disposed) return;
    this.coordinator?.beginFrame();
    this.poll();
    // The renderer may consume the scene after this JS frame.
    this.schedule();
  }

  private poll(): void {
    if (this.disposed || !this.runtime.overviewCacheSnapshot) return;
    const generation = this.runtime.generation?.() ?? 0;
    if (generation !== this.rendererGeneration) {
      this.rendererGeneration = generation;
      for (const pending of this.pending.values()) {
        pending.signal.removeEventListener("abort", pending.onAbort);
        pending.reject(new Error("overview-cache-renderer-rebuilt"));
      }
      this.pending.clear();
      for (const pending of this.releases.values()) pending.resolve();
      this.releases.clear();
      this.coordinator?.rendererRebuilt();
    }
    let snapshot: Snapshot;
    try { snapshot = JSON.parse(this.runtime.overviewCacheSnapshot()) as Snapshot; }
    catch { return; }
    if (!Array.isArray(snapshot.candidates) || !Array.isArray(snapshot.results) || !Array.isArray(snapshot.releases)) return;
    this.waitingDependencies = snapshot.candidates.some(candidate => candidate.reason === "Dependencies"
      && typeof candidate.ownerId === "string" && this.residency.isAdmitted(candidate.ownerId));
    if (!this.waitingDependencies) this.retryIndex = 0;
    const inputs = snapshot.candidates.filter(candidate => typeof candidate.ownerId === "string"
      && /^[0-9a-f]{16}$/.test(candidate.fingerprint)
      && [128, 256, 512, 1024, 2048].includes(candidate.tier)
      && Number.isFinite(candidate.bytes) && (candidate.eligible ? candidate.bytes > 0 : candidate.bytes >= 0))
      .map(candidate => ({ ...candidate, stable: true, dynamic: this.isDynamic(candidate.ownerId),
        fallbackReason: candidate.eligible ? "budget" as const : fallbackReason(candidate.reason),
        eligible: candidate.eligible && this.residency.isAdmitted(candidate.ownerId) }));
    this.coordinator?.sync(inputs);
    this.recordDiagnostics(snapshot.candidates);
    for (const result of snapshot.results) {
      const key = this.key(result.owner, result.epoch, result.generation);
      const pending = this.pending.get(key);
      if (!pending) continue;
      if (pending.signal.aborted && !result.cancelled) continue;
      this.pending.delete(key);
      queueMicrotask(() => pending.signal.removeEventListener("abort", pending.onAbort));
      if (result.success) pending.resolve();
      else pending.reject(new Error("overview-cache-render-failed"));
    }
    for (const result of snapshot.releases) {
      const pending = this.releases.get(result.requestId);
      if (!pending || pending.owner !== result.owner || pending.epoch !== result.epoch) continue;
      this.releases.delete(result.requestId);
      pending.resolve();
    }
  }

  private recordDiagnostics(candidates: Snapshot["candidates"]): void {
    if (telemetryBuildMode() !== "dev" || candidates.length === 0 ||
      candidates.some(candidate => typeof candidate.modelDeclared !== "boolean" || typeof candidate.mediaDeclared !== "number")) return;
    const client = activeTelemetryClient();
    if (!client) return;
    const lod = readOverviewLodDistribution(this.runtime.getWorkDiagnostics?.());
    if (!lod) return;
    const counts = { total: candidates.length, model: 0, media: 0, quality: 0, ready: 0, admitted: 0, overlap: 0, dynamic: 0, hidden: 0 };
    for (const candidate of candidates) {
      if (this.residency.isAdmitted(candidate.ownerId)) counts.admitted++;
      if (candidate.reason === "Dependencies") {
        if (candidate.modelDeclared && !candidate.modelReady) counts.model++;
        if ((candidate.mediaDeclared ?? 0) > 0 && !candidate.mediaReady) counts.media++;
      }
      if (candidate.reason === "Quality") counts.quality++;
      if (candidate.reason === "Overlap") counts.overlap++;
      if (candidate.reason === "Dynamic") counts.dynamic++;
      if (candidate.reason === "Hidden" || candidate.reason === "Undeclared") counts.hidden++;
      if (candidate.eligible) counts.ready++;
    }
    const cached = this.coordinator?.diagnostics?.().entries.filter(entry => entry.state === "Cached").length ?? 0;
    const raster = `cache:n=${counts.total},model=${counts.model},media=${counts.media},quality=${counts.quality},overlap=${counts.overlap},dynamic=${counts.dynamic},hidden=${counts.hidden},ready=${counts.ready},admit=${counts.admitted},cached=${cached}`;
    const now = Date.now();
    if (now - this.lastTelemetryAt < (raster === this.lastTelemetry ? 60_000 : 2_000)) return;
    try {
      client.record({ name: "perf.lod", result: "success", origin: "browser", surface: "canvas",
        attributes: { mode: "dev", low: lod.low, medium: lod.medium, high: lod.high, preparing: lod.preparing, raster } });
      this.lastTelemetry = raster;
      this.lastTelemetryAt = now;
    } catch { /* Diagnostics must not affect rendering. */ }
  }

  private schedule(delay = 50): void {
    if (this.disposed || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.coordinator?.beginFrame();
      this.poll();
      if (this.pending.size || this.releases.size) this.schedule();
      else if (this.waitingDependencies) {
        const delays = [250, 1000, 4000, 15000];
        this.schedule(delays[Math.min(this.retryIndex++, delays.length - 1)]);
      }
    }, delay);
  }

  private command(value: object): void { this.runtime.overviewCacheCommand!(JSON.stringify(value)); }
  private key(owner: string, epoch: number, generation: number): string { return JSON.stringify([owner, epoch, generation]); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    for (const pending of this.pending.values()) {
      pending.signal.removeEventListener("abort", pending.onAbort);
      pending.reject(new Error("overview-cache-renderer-disposed"));
    }
    for (const pending of this.releases.values()) pending.reject(new Error("overview-cache-renderer-disposed"));
    this.pending.clear();
    this.releases.clear();
    this.coordinator = null;
  }
}
