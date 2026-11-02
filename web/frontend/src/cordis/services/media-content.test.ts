import { applyCanvasCommands } from "../../../../test-support/managed-shot-commands.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalFilmSetFields, createEmptyWoohaa3ServerCanvas, createFilmSetSnapshot, createMotionSnapshot, shotPreviewNodeId, type ServerCanvas, type StoredAsset } from "@woohaa3/contracts";
import type { MediaContentProvider } from "../../extension-api/media-content.js";
import { createMediaContentService } from "./media-content.js";
const asset = (id: string, mediaKind: "image" | "video" = "image"): StoredAsset => ({ id, mediaKind, status: "ready", source: "generated", title: id, createdAt: "2026-10-25", metadata: { storageKey: `sha256-${"a".repeat(64)}`, checksum: id } });
const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach(f => f()));

it.each(["image", "video"] as const)("persists the provider result on a real managed film-set %s node", async kind => {
  let canvas = createEmptyWoohaa3ServerCanvas("managed-provider");
  const animation = createFilmSetSnapshot({ title: "Film", model: { modelScript: 'scene.box({id:"body"});', modelScriptVersion: "woohaa-model-js-v2" }, motionScript: 'motion.model.rotate("body", {speed:1});', timeline: { duration: 4, loop: false } });
  if (kind === "image") animation.filmSetAnimations!.clips[0] = {
    ...animation.filmSetAnimations!.clips[0]!, kind: "static", timeline: { duration: 0, loop: false }, bindings: [],
    cameraMotion: createMotionSnapshot({ motionScript: "", basedOnModelVersion: { revision: 1, sourceHash: "camera", contentHash: "camera" } }),
  };
  canvas.document.nodes = [{ id: "film", type: "composite-asset", position: { x: 0, y: 0 } }];
  canvas.nodeData.film = canonicalFilmSetFields(animation) as never;
  const initial = applyCanvasCommands(canvas, [{ type: "canvas.setTitle", title: "Film" }]);
  if (!initial.ok) throw Error(initial.rejection.message);
  canvas = initial.canvas;
  const id = shotPreviewNodeId("film", "clip-1"), ownership = structuredClone(canvas.nodeData[id].managedBy);
  const listeners = new Set<() => void>();
  const submit = vi.fn(async commands => {
    const result = applyCanvasCommands(canvas, commands);
    if (!result.ok) throw Error(result.rejection.message);
    canvas = result.canvas; listeners.forEach(fn => fn());
  });
  const service = createMediaContentService({ canvas: () => canvas, subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, writable: () => true, submit });
  disposers.push(service.dispose);
  const ready = asset("generated-shot", kind);
  service.register({ providerId: "film-set.shot", owner: "film-set", schemaVersions: [1], mediaKinds: [kind],
    describe: () => ({ mediaKind: kind, sourceIdentity: "current-shot", dependencyNodeIds: ["film"] }),
    resolvePreview: async () => ready, materialize: async () => ready, snapshot: async () => ready,
  });
  await vi.waitFor(() => expect(service.state(id)?.status).toBe("ready"));
  expect(submit).toHaveBeenCalledTimes(1);
  expect(canvas.nodeData[id]).toMatchObject({ outputAssetId: ready.id, status: "ready", managedBy: ownership, mediaContent: { providerId: "film-set.shot" } });
  expect(canvas.assets).toContainEqual(ready);
  const frozen = await service.freeze(canvas, [id], "copy");
  expect(frozen.nodeData[id]).toMatchObject({ outputAssetId: ready.id });
  expect(frozen.nodeData[id].managedBy).toBeUndefined();
  expect(frozen.nodeData[id].mediaContent).toBeUndefined();
});
function fixture(writable = false) {
  let canvas = createEmptyWoohaa3ServerCanvas("media", "2026-10-25");
  canvas.document.nodes = [{ id: "source", type: "text", position: { x: 0, y: 0 } }, { id: "live", type: "image", position: { x: 50, y: 0 } }];
  canvas.nodeData = { source: { title: "one" }, live: { mediaContent: { providerId: "test.content", schemaVersion: 1, payload: { nodeId: "source" } } } };
  const listeners = new Set<() => void>();
  const changed = () => { for (const fn of listeners) fn(); };
  const submit = vi.fn(async commands => {
    const result = applyCanvasCommands(canvas, commands);
    if (!result.ok) throw Error(result.rejection.message);
    canvas = result.canvas; changed();
  });
  const service = createMediaContentService({ canvas: () => canvas, subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, writable: () => writable, submit });
  disposers.push(service.dispose);
  const provider: MediaContentProvider = { providerId: "test.content", owner: "test", schemaVersions: [1], mediaKinds: ["image"],
    describe: c => ({ mediaKind: "image", sourceIdentity: String(c.nodeData.source?.title), dependencyNodeIds: ["source"] }),
    resolvePreview: async () => null, materialize: vi.fn(async () => asset("one")), snapshot: vi.fn(async () => asset("one")) };
  return { service, provider, submit, changed, canvas: () => canvas, setCanvas: (next: ServerCanvas) => { canvas = next; changed(); } };
}
describe("page-scoped open media content", () => {
  it("reads only a verified preview on a read-only canvas without materializing or writing", async () => {
    const f = fixture(false);
    f.provider.resolvePreview = async () => asset("verified-current");
    f.service.register(f.provider);
    await vi.waitFor(() => expect(f.service.state("live")).toMatchObject({ status: "ready", sourceIdentity: "one", asset: { id: "verified-current" } }));
    expect(f.provider.materialize).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
    f.canvas().nodeData.source.title = "two";
    f.provider.resolvePreview = async () => null;
    f.changed();
    await vi.waitFor(() => expect(f.service.state("live")).toMatchObject({ status: "unavailable", sourceIdentity: "two" }));
    expect(f.provider.materialize).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
  });
  it("retries a transient writeback failure on the next canvas change", async () => {
    const f = fixture(true);
    // 第一次写回失败（宿主短暂重连 / 并发画布写入）；没有 provider 新状态通知时，
    // 后续画布变化仍必须能重试，而不是把同一内容身份永久判为失败。
    f.submit.mockImplementationOnce(async () => { throw Error("host-reconnecting"); });
    f.service.register(f.provider);
    await vi.waitFor(() => expect(f.service.state("live")?.status).toBe("failed"));
    f.canvas().nodeData.source.title = "two";
    f.changed();
    await vi.waitFor(() => expect(f.canvas().nodeData.live.outputAssetId).toBe("one"));
    expect(f.service.state("live")?.status).toBe("ready");
  });
  it("repairs a ready asset whose outputAssetId writeback was missed", async () => {
    const f = fixture(true);
    f.service.register(f.provider);
    await vi.waitFor(() => expect(f.canvas().nodeData.live.outputAssetId).toBe("one"));
    // 模拟并发写入把 outputAssetId 覆盖回旧值：provider 仍是 ready，不会再发通知。
    f.canvas().nodeData.live.outputAssetId = "stale";
    f.changed();
    await vi.waitFor(() => expect(f.canvas().nodeData.live.outputAssetId).toBe("one"));
  });
  it("recovers a failed producer when readiness changes without editing its source", async () => {    const f = fixture(true);
    const callbacks = new Set<() => void>();
    let ready = false;
    const unsubscribe = vi.fn();
    f.provider.subscribe = fn => { callbacks.add(fn); return () => { callbacks.delete(fn); unsubscribe(); }; };
    f.provider.resolvePreview = vi.fn(async () => ready ? asset("ready-after-startup") : null);
    f.provider.materialize = vi.fn(async () => {
      if (!ready) throw Error("renderer-not-ready");
      return asset("ready-after-startup");
    });
    const release = f.service.register(f.provider);
    await vi.waitFor(() => expect(f.service.state("live")).toMatchObject({ status: "failed", diagnostic: "Error: renderer-not-ready" }));
    expect(f.submit).not.toHaveBeenCalled();
    ready = true;
    callbacks.forEach(fn => fn());
    await vi.waitFor(() => expect(f.service.state("live")?.status).toBe("ready"));
    expect(f.canvas().nodeData.live.outputAssetId).toBe("ready-after-startup");
    expect(f.provider.resolvePreview).toHaveBeenCalledTimes(2);
    expect(f.submit).toHaveBeenCalledOnce();
    release(); expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it("rejects collisions, unsupported versions and kind mismatch; unknown content stays intact", () => {
    const f = fixture(); const before = structuredClone(f.canvas().nodeData.live);
    expect(() => f.service.describe(f.canvas(), before.mediaContent!, "image")).toThrow("provider-unavailable");
    const release = f.service.register(f.provider);
    expect(() => f.service.register(f.provider)).toThrow("provider-id-conflict");
    expect(() => f.service.describe(f.canvas(), { ...before.mediaContent!, schemaVersion: 2 }, "image")).toThrow("version-unsupported");
    expect(() => f.service.describe(f.canvas(), before.mediaContent!, "video")).toThrow("kind-mismatch");
    release(); expect(f.canvas().nodeData.live).toEqual(before); expect(f.submit).not.toHaveBeenCalled();
  });
  it("freezes an independent asset and deduplicates a stable request without mutating the live node", async () => {
    const f = fixture(); f.service.register(f.provider);
    const [one, retry] = await Promise.all([f.service.freeze(f.canvas(), ["live"], "copy"), f.service.freeze(f.canvas(), ["live"], "copy")]);
    expect(f.provider.snapshot).toHaveBeenCalledTimes(1); expect(one).toEqual(retry);
    expect(one.nodeData.live.mediaContent).toBeUndefined(); expect(one.nodeData.live.outputAssetId).toBe("one");
    expect(f.canvas().nodeData.live.mediaContent?.providerId).toBe("test.content");
    f.canvas().nodeData.source.title = "two";
    expect(one.assets[0].id).toBe("one"); expect(f.submit).not.toHaveBeenCalled();
  });
  it.each(["source", "target", "unregister", "dispose"])("isolates late materialization after %s invalidation", async invalidation => {
    const f = fixture(); let finish!: (asset: StoredAsset) => void;
    f.provider.materialize = () => new Promise(resolve => { finish = resolve; });
    const release = f.service.register(f.provider);
    const pending = f.service.resolve("live", "materialize", "late"); await Promise.resolve();
    if (invalidation === "source") f.canvas().nodeData.source.title = "two";
    if (invalidation === "target") f.canvas().document.nodes = f.canvas().document.nodes.filter(n => n.id !== "live");
    if (invalidation === "unregister") release();
    if (invalidation === "dispose") f.service.dispose();
    f.changed(); finish(asset("late")); await expect(pending).rejects.toThrow("stale"); expect(f.submit).not.toHaveBeenCalled();
  });
  it("rejects an invalid result and snapshot failure creates no assets or nodes", async () => {
    const f = fixture(); f.provider.snapshot = async () => asset("wrong", "video"); f.service.register(f.provider);
    const before = structuredClone(f.canvas());
    await expect(f.service.freeze(f.canvas(), ["live"], "copy")).rejects.toThrow("invalid-result");
    expect(f.canvas()).toEqual(before); expect(f.submit).not.toHaveBeenCalled();
  });
  it("asset provider reuses immutable content and remains available after an unrelated extension unload", async () => {
    const f = fixture(); const release = f.service.register(f.provider); release();
    f.canvas().assets = [asset("ordinary")]; f.canvas().nodeData.live.mediaContent = { providerId: "asset", schemaVersion: 1, payload: { assetId: "ordinary" } };
    expect((await f.service.freeze(f.canvas(), ["live"], "copy")).nodeData.live).toEqual({ outputAssetId: "ordinary" });
  });
});

it("rejects reuse of a snapshot request after its source changed and permits a new request", async () => {
  const f = fixture(); f.service.register(f.provider);
  await f.service.freeze(f.canvas(), ["live"], "stable-copy");
  f.canvas().nodeData.source.title = "two";
  await expect(f.service.freeze(f.canvas(), ["live"], "stable-copy")).rejects.toThrow("request-id-reused");
  expect(f.provider.snapshot).toHaveBeenCalledTimes(1);
  await f.service.freeze(f.canvas(), ["live"], "new-copy");
  expect(f.provider.snapshot).toHaveBeenCalledTimes(2);
});

it.each(["image", "video"] as const)("updates live %s atomically, preserves the previous immutable result and refreshes across scopes", async kind => {
  let canvas = createEmptyWoohaa3ServerCanvas("refresh", "2026-10-25");
  canvas.document.nodes = [{ id: "source", type: "text", position: { x: 0, y: 0 } }, { id: "live", type: kind, position: { x: 0, y: 0 } }];
  canvas.nodeData = { source: { title: "one" }, live: { mediaContent: { providerId: "test.content", schemaVersion: 1, payload: {} } } };
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach(fn => fn());
  let finish!: (value: StoredAsset) => void;
  const mount = () => {
    const service = createMediaContentService({ canvas: () => canvas, subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; }, writable: () => true,
      submit: async commands => { const result = applyCanvasCommands(canvas, commands); if (!result.ok) throw Error(result.rejection.message); canvas = result.canvas; changed(); } });
    disposers.push(service.dispose); return service;
  };
  let service = mount();
  const provider: MediaContentProvider = { providerId: "test.content", owner: "test", schemaVersions: [1], mediaKinds: [kind],
    describe: c => ({ mediaKind: kind, sourceIdentity: String(c.nodeData.source.title), dependencyNodeIds: ["source"] }),
    resolvePreview: async () => null, materialize: async c => c.source.sourceIdentity === "one" ? asset("one", kind) : new Promise(resolve => { finish = resolve; }), snapshot: async () => asset("one", kind) };
  const release = service.register(provider);
  await vi.waitFor(() => expect(canvas.nodeData.live.outputAssetId).toBe("one"));
  const frozen = await service.freeze(canvas, ["live"], "copy-one");
  canvas.nodeData.source.title = "two"; changed();
  await vi.waitFor(() => expect(service.state("live")?.status).toBe("pending"));
  expect(canvas.nodeData.live.outputAssetId).toBe("one"); finish(asset("two", kind));
  await vi.waitFor(() => expect(canvas.nodeData.live.outputAssetId).toBe("two"));
  expect(canvas.assets.map(a => a.id).sort()).toEqual(["one", "two"]);
  expect(frozen.nodeData.live.outputAssetId).toBe("one"); expect(frozen.nodeData.live.mediaContent).toBeUndefined();
  release(); await vi.waitFor(() => expect(service.state("live")?.status).toBe("unavailable"));
  expect(canvas.nodeData.live.mediaContent?.providerId).toBe("test.content");
  service.dispose(); service = mount();
  provider.materialize = async () => asset("two", kind); service.register(provider);
  await vi.waitFor(() => expect(service.state("live")?.status).toBe("ready"));
  expect(canvas.assets).toHaveLength(2);
});
