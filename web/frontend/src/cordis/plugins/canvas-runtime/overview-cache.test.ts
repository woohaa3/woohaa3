import { describe, expect, it, vi } from "vitest";
import { CanvasResourceCoordinator } from "./residency/index.js";
import { OverviewCacheCoordinator, type OverviewCacheInput } from "./overview-cache.js";
import { createResidencyProjector } from "./residency/projection.js";

const input = (fingerprint: string, ownerId = "film-1"): OverviewCacheInput => ({
  ownerId, fingerprint, tier: 256, bytes: 256 * 256 * 4, stable: true, eligible: true
});

describe("OverviewCacheCoordinator", () => {
  it("uses the shared preview budget and publishes only the latest token", async () => {
    const residency = new CanvasResourceCoordinator({ policy: { previewSlots: 1, previewRefreshesPerFrame: 1, gpuDerivedBytes: 2_000_000 } });
    let renders = 0;
    const cache = new OverviewCacheCoordinator(residency, () => 0, async () => { renders += 1; });
    cache.beginFrame();
    cache.sync([input("a")]);
    await Promise.resolve();
    expect(cache.diagnostics().entries[0]?.state).toBe("Cached");
    expect(renders).toBe(1);
    cache.sync([input("a")]);
    expect(cache.diagnostics().entries[0]?.refreshes).toBe(1);
    expect(cache.diagnostics().entries[0]?.hits).toBe(1);
    cache.beginFrame();
    cache.sync([input("b")]);
    await Promise.resolve();
    expect(cache.diagnostics().entries[0]?.fingerprint).toBe("b");
    expect(cache.diagnostics().entries[0]?.generation).toBe(2);
    cache.dispose();
    residency.dispose();
  });

  it("keeps an unstable owner realtime and revokes removed owners", () => {
    const residency = new CanvasResourceCoordinator();
    const cache = new OverviewCacheCoordinator(residency);
    cache.sync([{ ...input("a"), stable: false }]);
    expect(cache.diagnostics().entries[0]?.state).toBe("Direct");
    expect(cache.diagnostics().entries[0]?.reason).toBe("unstable");
    cache.sync([]);
    expect(cache.diagnostics().entries).toEqual([]);
    cache.dispose();
    residency.dispose();
  });

  it("supports a diagnostic-only disabled comparison mode", () => {
    const residency = new CanvasResourceCoordinator();
    const cache = new OverviewCacheCoordinator(residency);
    cache.setBenchmarkDisabled(true);
    cache.sync([input("a")]);
    expect(cache.diagnostics().entries[0]?.reason).toBe("disabled");
    expect(cache.diagnostics().entries[0]?.state).toBe("Direct");
    cache.dispose();
    residency.dispose();
  });

  it("drains a superseded render before starting another and ignores its completion", async () => {
    const residency = new CanvasResourceCoordinator({ policy: { previewSlots: 4, previewRefreshesPerFrame: 1 } });
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const renders: string[] = [];
    const cache = new OverviewCacheCoordinator(residency, () => 0, async value => {
      renders.push(value.fingerprint);
      if (value.fingerprint === "a") await pending;
    });
    cache.beginFrame();
    cache.sync([input("a")]);
    cache.beginFrame();
    cache.sync([input("b")]);
    expect(renders).toEqual(["a"]);
    expect(residency.channelSnapshot("preview").draining).toBe(1);
    expect(residency.diagnostics().estimatedGpuBytes).toBe(262_144);
    expect(cache.diagnostics().drainingBytes).toBe(262_144);
    expect(cache.diagnostics().activeViews).toBe(1);
    finish();
    await pending;
    await Promise.resolve();
    expect(cache.diagnostics().entries[0]?.refreshes).toBe(0);
    expect(residency.diagnostics().estimatedGpuBytes).toBe(0);
    expect(cache.diagnostics().drainingBytes).toBe(0);
    cache.beginFrame();
    cache.sync([input("b")]);
    await Promise.resolve();
    expect(renders).toEqual(["a", "b"]);
    expect(cache.diagnostics().entries[0]?.refreshes).toBe(1);
    cache.dispose();
    residency.dispose();
  });

  it("cancels an in-flight render on dynamic transition", async () => {
    const residency = new CanvasResourceCoordinator();
    let finish!: () => void;
    let signal!: AbortSignal;
    const cache = new OverviewCacheCoordinator(residency, () => 0, async (_input, _token, lease) => {
      signal = lease.signal;
      await new Promise<void>(resolve => { finish = resolve; });
    });
    cache.sync([input("a")]);
    cache.sync([{ ...input("a"), dynamic: true }]);
    expect(signal.aborted).toBe(true);
    expect(residency.channelSnapshot("preview").draining).toBe(1);
    finish();
    await Promise.resolve();
    expect(cache.diagnostics().entries[0]?.state).toBe("Direct");
    expect(cache.diagnostics().entries[0]?.refreshes).toBe(0);
    cache.dispose();
    residency.dispose();
  });

  it("retains displayed bytes and reserves both images and attachments during refresh", async () => {
    const residency = new CanvasResourceCoordinator({ policy: { gpuDerivedBytes: 700_000 } });
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const released: string[] = [];
    const cache = new OverviewCacheCoordinator(residency, () => 0, async value => {
      if (value.fingerprint === "b") await pending;
    }, owner => { released.push(owner); });
    cache.sync([{ ...input("a"), attachmentBytes: 100_000 }]);
    await Promise.resolve();
    expect(residency.diagnostics().estimatedGpuBytes).toBe(262_144);
    cache.beginFrame();
    cache.sync([{ ...input("b"), attachmentBytes: 100_000 }]);
    expect(residency.diagnostics().estimatedGpuBytes).toBe(624_288);
    expect(cache.diagnostics().attachmentBytes).toBe(100_000);
    finish();
    await vi.waitFor(() => expect(residency.diagnostics().estimatedGpuBytes).toBe(262_144));
    cache.sync([]);
    expect(released).toEqual(["film-1"]);
    expect(residency.diagnostics().estimatedGpuBytes).toBe(0);
    cache.dispose();
    residency.dispose();
  });

  it("evicts a displayed cache before admitting an interactive demand under pressure", async () => {
    const residency = new CanvasResourceCoordinator({ policy: { gpuDerivedBytes: 1_200_000 } });
    const released: string[] = [];
    const cache = new OverviewCacheCoordinator(residency, () => 0, async () => undefined, owner => { released.push(owner); });
    cache.sync([input("a")]);
    await Promise.resolve();
    expect(cache.diagnostics().entries[0]?.state).toBe("Cached");
    residency.project({
      viewport: { x: 0, y: 0, zoom: 1 }, surface: { width: 800, height: 600, pixelRatio: 1 },
      pageVisible: true, interactive: ["editing"], pins: [],
      candidates: [{ nodeId: "editing", contentKey: "model", x: 0, y: 0, width: 512, height: 512, eligible: true, previewSlot: true }]
    });
    expect(released).toEqual(["film-1"]);
    expect(cache.diagnostics().entries[0]?.reason).toBe("budget");
    expect(residency.isAdmitted("editing")).toBe(true);
    expect(residency.diagnostics().estimatedGpuBytes).toBe(1_048_576);
    cache.dispose();
    residency.dispose();
  });

  it("keeps displayed bytes until the renderer confirms release", async () => {
    const residency = new CanvasResourceCoordinator();
    let confirm!: () => void;
    const released = new Promise<void>(resolve => { confirm = resolve; });
    const release = vi.fn(() => released);
    const cache = new OverviewCacheCoordinator(residency, () => 0, async () => undefined, release);
    cache.sync([input("a")]);
    await Promise.resolve();
    cache.sync([]);
    expect(release).toHaveBeenCalledWith("film-1", expect.objectContaining({ generation: 1 }));
    expect(residency.diagnostics().estimatedGpuBytes).toBe(262_144);
    confirm();
    await vi.waitFor(() => expect(residency.diagnostics().estimatedGpuBytes).toBe(0));
    cache.dispose();
    residency.dispose();
  });

  it("keeps an evicted render charged while the underlying work drains", async () => {
    const wake = vi.fn();
    const residency = new CanvasResourceCoordinator({ policy: { gpuDerivedBytes: 1_200_000 }, onGpuClaimReleased: wake });
    let finish!: () => void;
    let signal!: AbortSignal;
    const cache = new OverviewCacheCoordinator(residency, () => 0, async (_input, _token, lease) => {
      signal = lease.signal;
      await new Promise<void>(resolve => { finish = resolve; });
    });
    cache.sync([input("a")]);
    const project = createResidencyProjector({
      coordinator: residency, getCanvas: () => null,
      viewport: () => ({ x: 0, y: 0, zoom: 1 }), surface: () => ({ width: 800, height: 600, pixelRatio: 1 }),
      pageVisible: () => true, interactive: () => ["editing"],
      candidatesFor: () => [{ nodeId: "editing", contentKey: "model", x: 0, y: 0, width: 512, height: 512, eligible: true, previewSlot: true }]
    });
    project();
    expect(signal.aborted).toBe(true);
    expect(residency.channelSnapshot("preview").draining).toBe(1);
    expect(residency.isAdmitted("editing")).toBe(false);
    expect(residency.diagnostics().estimatedGpuBytes).toBe(262_144);
    finish();
    await vi.waitFor(() => expect(residency.diagnostics().estimatedGpuBytes).toBe(0));
    expect(wake).toHaveBeenCalled();
    project();
    expect(residency.isAdmitted("editing")).toBe(true);
    expect(cache.diagnostics().entries[0]?.refreshes).toBe(0);
    cache.dispose();
    residency.dispose();
  });
});
