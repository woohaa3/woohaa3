import { afterEach, describe, expect, it, vi } from "vitest";
import { OverviewCacheBridge } from "./overview-cache-bridge.js";
import { CanvasResourceCoordinator, type ResidencyLease } from "./residency/index.js";
import type { BevyRuntime } from "./bevy-runtime-types.js";
import { OverviewCacheCoordinator } from "./overview-cache.js";
import { setTelemetryBuildModeForTesting, setTelemetryClientForTesting } from "../../services/telemetry-primitives.js";

afterEach(() => { vi.useRealTimers(); setTelemetryBuildModeForTesting(undefined); setTelemetryClientForTesting(undefined); });

describe("OverviewCacheBridge", () => {
  it("records bounded dependency diagnostics without owner identities", () => {
    const record = vi.fn();
    setTelemetryBuildModeForTesting("dev");
    setTelemetryClientForTesting({ record } as never);
    const runtime = { getWorkDiagnostics: () => ({ models: { overviewLod: { roots: [{ published: "low" }] } } }), overviewCacheSnapshot: () => JSON.stringify({ candidates: [
      { ownerId: "private-id", reason: "Dependencies", modelDeclared: true, modelReady: false, mediaDeclared: 2, mediaReady: false },
      { ownerId: "other", reason: "Quality", modelDeclared: true, modelReady: true, mediaDeclared: 0, mediaReady: true }
    ], results: [], releases: [] }) } as unknown as BevyRuntime;
    const residency = new CanvasResourceCoordinator();
    const bridge = new OverviewCacheBridge(runtime, residency);
    bridge.frame();
    bridge.frame();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0].attributes.raster).toBe("cache:n=2,model=1,media=1,quality=1,overlap=0,dynamic=0,hidden=0,ready=0,admit=0,cached=0");
    bridge.dispose();
    residency.dispose();
  });
  it("waits for matching terminal feedback after cancellation and release", async () => {
    vi.useFakeTimers();
    const commands: Array<Record<string, unknown>> = [];
    let snapshot = { candidates: [], results: [] as object[], releases: [] as object[] };
    const runtime = {
      overviewCacheSnapshot: () => JSON.stringify(snapshot),
      overviewCacheCommand: (json: string) => { commands.push(JSON.parse(json)); }
    } as unknown as BevyRuntime;
    const residency = new CanvasResourceCoordinator();
    const bridge = new OverviewCacheBridge(runtime, residency);
    const controller = new AbortController();
    const token = { ownerId: "film", generation: 3, epoch: 5, slotGeneration: 1 };
    const render = bridge.render({ ownerId: "film", fingerprint: "0000000000000007", tier: 256, bytes: 64, stable: true, eligible: true }, token, { signal: controller.signal } as ResidencyLease);
    controller.abort();
    expect(commands.map(command => command.kind)).toEqual(["render", "cancel"]);
    snapshot = { ...snapshot, results: [{ owner: "film", epoch: 5, generation: 2, success: true }] };
    bridge.frame();
    expect(commands).toHaveLength(2);
    snapshot = { ...snapshot, results: [{ owner: "film", epoch: 5, generation: 3, success: true, cancelled: false }] };
    bridge.frame();
    snapshot = { ...snapshot, results: [{ owner: "film", epoch: 5, generation: 3, success: false, cancelled: true }] };
    bridge.frame();
    await expect(render).rejects.toThrow("overview-cache-render-failed");
    const release = bridge.release("film", token);
    const requestId = commands.at(-1)?.requestId;
    snapshot = { ...snapshot, releases: [{ owner: "film", epoch: 5, requestId }] };
    bridge.frame();
    await expect(release).resolves.toBeUndefined();
    bridge.dispose();
    residency.dispose();
  });

  it("invalidates old work when the renderer generation changes", async () => {
    vi.useFakeTimers();
    let generation = 1;
    const runtime = {
      generation: () => generation,
      overviewCacheSnapshot: () => JSON.stringify({ candidates: [], results: [], releases: [] }),
      overviewCacheCommand: () => undefined
    } as unknown as BevyRuntime;
    const residency = new CanvasResourceCoordinator();
    const bridge = new OverviewCacheBridge(runtime, residency);
    const coordinator = { beginFrame: vi.fn(), rendererRebuilt: vi.fn(), sync: vi.fn() };
    bridge.connect(coordinator as unknown as OverviewCacheCoordinator);
    const controller = new AbortController();
    const pending = bridge.render({ ownerId: "film", fingerprint: "0000000000000007", tier: 256, bytes: 64, stable: true, eligible: true },
      { ownerId: "film", generation: 1, epoch: 1, slotGeneration: 1 }, { signal: controller.signal } as ResidencyLease);
    generation = 2;
    bridge.frame();
    await expect(pending).rejects.toThrow("overview-cache-renderer-rebuilt");
    expect(coordinator.rendererRebuilt).toHaveBeenCalledOnce();
    bridge.dispose();
    residency.dispose();
  });

  it("rechecks admitted dependencies with bounded backoff", () => {
    vi.useFakeTimers();
    const read = vi.fn(() => JSON.stringify({ candidates: [{ ownerId: "film", fingerprint: "0000000000000007", tier: 256, bytes: 64, eligible: false, reason: "Dependencies" }], results: [], releases: [] }));
    const runtime = { overviewCacheSnapshot: read, overviewCacheCommand: () => undefined } as unknown as BevyRuntime;
    const residency = new CanvasResourceCoordinator();
    residency.project({ viewport: { x: 0, y: 0, zoom: 1 }, surface: { width: 800, height: 600, pixelRatio: 1 }, pageVisible: true,
      interactive: [], pins: [], candidates: [{ nodeId: "film", contentKey: "model", x: 0, y: 0, width: 100, height: 100, eligible: true }] });
    const bridge = new OverviewCacheBridge(runtime, residency);
    bridge.frame();
    vi.advanceTimersByTime(50);
    expect(read).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(249);
    expect(read).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(read).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1000);
    expect(read).toHaveBeenCalledTimes(4);
    bridge.dispose();
    residency.dispose();
  });

  it("keeps fallback reasons in the coordinator diagnostics input", () => {
    vi.useFakeTimers();
    const runtime = { overviewCacheSnapshot: () => JSON.stringify({ candidates: [
      { ownerId: "film", fingerprint: "0000000000000007", tier: 128, bytes: 0, eligible: false, reason: "Quality" }
    ], results: [], releases: [] }) } as unknown as BevyRuntime;
    const residency = new CanvasResourceCoordinator();
    const bridge = new OverviewCacheBridge(runtime, residency);
    const coordinator = { beginFrame: vi.fn(), rendererRebuilt: vi.fn(), sync: vi.fn() };
    bridge.connect(coordinator as unknown as OverviewCacheCoordinator);
    bridge.frame();
    expect(coordinator.sync).toHaveBeenCalledWith([expect.objectContaining({ ownerId: "film", eligible: false, fallbackReason: "quality" })]);
    bridge.dispose();
    residency.dispose();
  });

  it("accepts a 2048-pixel candidate for budget admission", () => {
    const runtime = { overviewCacheSnapshot: () => JSON.stringify({ candidates: [
      { ownerId: "film", fingerprint: "0000000000000007", tier: 2048, bytes: 16777216, eligible: true }
    ], results: [], releases: [] }) } as unknown as BevyRuntime;
    const residency = new CanvasResourceCoordinator();
    const bridge = new OverviewCacheBridge(runtime, residency);
    const coordinator = { beginFrame: vi.fn(), sync: vi.fn() };
    bridge.connect(coordinator as unknown as OverviewCacheCoordinator);
    bridge.frame();
    expect(coordinator.sync).toHaveBeenCalledWith([expect.objectContaining({ tier: 2048, bytes: 16777216 })]);
    bridge.dispose();
    residency.dispose();
  });

  it("settles the shared budget only after matching renderer acknowledgements", async () => {
    vi.useFakeTimers();
    const commands: Array<Record<string, unknown>> = [];
    const candidate = { ownerId: "film", fingerprint: "0000000000000007", tier: 128, bytes: 100, attachmentBytes: 200, eligible: true };
    let snapshot = { candidates: [candidate], results: [] as object[], releases: [] as object[] };
    const runtime = { generation: () => 1, overviewCacheSnapshot: () => JSON.stringify(snapshot),
      overviewCacheCommand: (json: string) => { commands.push(JSON.parse(json)); } } as unknown as BevyRuntime;
    const residency = new CanvasResourceCoordinator({ policy: { gpuDerivedBytes: 100_000 } });
    residency.project({ viewport: { x: 0, y: 0, zoom: 1 }, surface: { width: 800, height: 600, pixelRatio: 1 }, pageVisible: true,
      interactive: [], pins: [], candidates: [{ nodeId: "film", contentKey: "model", x: 0, y: 0, width: 100, height: 100, eligible: true }] });
    const baseline = residency.diagnostics().estimatedGpuBytes;
    const bridge = new OverviewCacheBridge(runtime, residency);
    const cache = new OverviewCacheCoordinator(residency, () => 0, bridge.render, bridge.release);
    bridge.connect(cache);
    bridge.frame();
    const command = commands[0];
    expect(command.kind).toBe("render");
    expect(residency.diagnostics().estimatedGpuBytes).toBe(baseline + 300);
    snapshot.results = [{ owner: "film", epoch: command.epoch, generation: command.generation, success: true, cancelled: false }];
    bridge.frame();
    await Promise.resolve();
    expect(cache.diagnostics().entries[0].state).toBe("Cached");
    expect(residency.diagnostics().estimatedGpuBytes).toBe(baseline + 100);
    snapshot = { candidates: [], results: [], releases: [] };
    bridge.frame();
    const release = commands.at(-1)!;
    expect(release.kind).toBe("release");
    expect(residency.diagnostics().estimatedGpuBytes).toBe(baseline + 100);
    snapshot.releases = [{ owner: "film", epoch: release.epoch, requestId: release.requestId }];
    bridge.frame();
    await Promise.resolve();
    expect(residency.diagnostics().estimatedGpuBytes).toBe(baseline);
    cache.dispose();
    bridge.dispose();
    residency.dispose();
  });
});
