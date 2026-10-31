import { describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, createFilmSetSnapshot, createMotionSnapshot, canonicalFilmSetFields, canonicalShotPreviewFields, shotPreviewNodeId, freezeShotImageReferences, shotImageReferenceAssetId, type CanvasTaskCatalog, type ServerCanvas, type FrozenShotImageReference } from "@woohaa3/contracts";
import { createSubmitCoordinator, type SubmitInput } from "./submit-coordinator.js";

function fixture(clock: { now?: () => number } = {}) {
  let canvas = createEmptyWoohaa3ServerCanvas("image-waiting");
  const snapshot = createFilmSetSnapshot({ title: "Film", model: { modelScript: 'scene.box({id:"body"});', modelScriptVersion: "woohaa-model-js-v2" }, motionScript: 'motion.model.rotate("body", {speed:1});', timeline: { duration: 4, loop: false } });
  snapshot.filmSetAnimations!.clips[0] = { ...snapshot.filmSetAnimations!.clips[0]!, kind: "static", timeline: { duration: 0, loop: false }, bindings: [], cameraMotion: createMotionSnapshot({ motionScript: "", basedOnModelVersion: { revision: 1, sourceHash: "camera", contentHash: "camera" } }) };
  const previewId = shotPreviewNodeId("film", "clip-1");
  canvas.nodeData.film = canonicalFilmSetFields(snapshot) as never;
  canvas.nodeData[previewId] = canonicalShotPreviewFields({ shotPreview: { schemaVersion: 1, filmSetNodeId: "film", clipId: "clip-1" } }) as never;
  canvas.document.nodes.push({ id: "film", type: "composite-asset", position: { x: 0, y: 0 } }, { id: previewId, type: "film-set-shot-preview", position: { x: 0, y: 0 } });
  for (const id of ["image-a", "image-b"]) {
    canvas.document.nodes.push({ id, type: "image", position: { x: 400, y: 0 } });
    canvas.nodeData[id] = { inputMapping: [{ slotId: `${id}-slot`, sourceNodeId: previewId, role: "shot_image_reference", sortKey: "0" }] } as never;
  }
  const catalog: CanvasTaskCatalog = { available: true, defaultModels: {}, models: [{ providerId: "test", modelKey: "image-model", providerModelId: "image-model", modelType: "image", title: "Image", interaction: { id: "generic-model", version: 1 }, inputSchema: {}, defaultInput: {}, taskTimeoutMs: 1000,
    bindings: [{ field: "images", semantic: "reference-image", valueFormat: "reference", roles: ["reference_image"], mediaKinds: ["image"], mediaTypes: ["image/png"], maxItems: 8 }] as never }] };
  const run = vi.fn(async (_request: unknown) => ({ ok: true as const, runId: "run", jobId: "job" })), cancel = vi.fn(async () => ({ ok: true as const }));
  let writable = true;
  const coordinator = createSubmitCoordinator({ store: { getState: () => ({ canvas }) }, client: { run, cancel }, imageReferenceBackground: () => "#ffffff", isWritable: () => writable, ...(clock.now ? { nowMs: clock.now } : {}) });
  const input = (nodeId = "image-a"): SubmitInput => ({ nodeId, modelKey: "image-model", prompt: "A", parameters: { strength: 1 }, catalog, expectedModelType: "image" });
  const freeze = (nodeId = "image-a") => freezeShotImageReferences(canvas, nodeId, "#ffffff") as FrozenShotImageReference[];
  const ready = (ref: FrozenShotImageReference) => canvas.assets.push({ id: shotImageReferenceAssetId(ref), title: "Still", mediaKind: "image", source: "generated", status: "ready", createdAt: "2026-10-23T00:00:00Z", metadata: { storageKey: "images/a.png", checksum: "a".repeat(64), contentType: "image/png", width: 1280, height: 720, background: "#ffffff", shotImageReference: ref } });
  return { coordinator, run, cancel, input, freeze, ready, canvas, changeCanvas: (next: ServerCanvas) => { canvas = next; }, snapshot, readonly: () => { writable = false; } };
}

describe("static image frozen submissions", () => {
  it("absorbs Enter repeats inside the 100ms window instead of starting a second run", async () => {
    let clock = 0;
    const h = fixture({ now: () => clock }), frozen = h.freeze();
    h.ready(frozen[0]!);
    expect((await h.coordinator.submit(h.input())).ok).toBe(true);
    clock = 50;
    expect(await h.coordinator.submit(h.input())).toMatchObject({ ok: false, error: "提交速度过快 请慢一点" });
    expect(h.run).toHaveBeenCalledOnce();
    // 越过 100ms 窗口后仍可发新的独立 run。
    clock = 150;
    expect((await h.coordinator.submit(h.input())).ok).toBe(true);
    expect(h.run).toHaveBeenCalledTimes(2);
  });
  it("keeps preflight reasons ahead of the rapid-submit hint", async () => {
    let clock = 0;
    const h = fixture({ now: () => clock }), frozen = h.freeze();
    h.ready(frozen[0]!);
    expect((await h.coordinator.submit(h.input())).ok).toBe(true);
    clock = 50;
    expect(await h.coordinator.submit(h.input())).toMatchObject({ ok: false, error: "提交速度过快 请慢一点" });
    expect(h.run).toHaveBeenCalledOnce();
    // 窗口内也要先报真正的阻止原因，不能被“太快”掩盖。
    const empty = h.input(); empty.prompt = "";
    expect(await h.coordinator.submit(empty)).toMatchObject({ ok: false, error: "请先输入提示词" });
  });
  it("automatic continuation is not throttled by the manual debounce window", async () => {
    let clock = 0;
    const h = fixture({ now: () => clock }), frozen = h.freeze();
    expect(await h.coordinator.submit(h.input())).toMatchObject({ ok: false, waiting: true });
    clock = 10;
    h.ready(frozen[0]!);
    // 画布更新触发的续交紧随手动提交之后，仍必须恰好续交一次。
    expect(await h.coordinator.retryWaiting()).toMatchObject([{ ok: true }]);
    expect(h.run).toHaveBeenCalledOnce();
  });
  it("permission loss or disconnect cancels waiting even if A has become ready", async () => {
    const h = fixture(), frozen = h.freeze();
    const notified = vi.fn(); h.coordinator.subscribeWaiting!(notified);
    await h.coordinator.submit(h.input()); h.ready(frozen[0]!); h.readonly();
    expect(await h.coordinator.retryWaiting()).toMatchObject([{ ok: false, error: expect.stringContaining("shot-image-permission-denied") }]);
    expect(h.run).not.toHaveBeenCalled(); expect(h.coordinator.pendingWaiting()).toEqual([]);
    expect(h.coordinator.waitingMessage!("image-a")).toContain("shot-image-permission-denied"); expect(notified).toHaveBeenCalled();
  });
  it("a later manual preflight error replaces the previous accepted waiting message", async () => {
    const h = fixture(); h.ready(h.freeze()[0]!);
    expect((await h.coordinator.submit(h.input())).ok).toBe(true);
    const input = h.input(); input.prompt = "";
    expect((await h.coordinator.submit(input)).ok).toBe(false);
    expect(h.coordinator.waitingMessage!("image-a")).toBe("请先输入提示词");
  });
  it("source deletion prevents submission even when the frozen A asset is ready", async () => {
    const h = fixture(), frozen = h.freeze(); await h.coordinator.submit(h.input());
    h.ready(frozen[0]!); delete h.canvas.nodeData.film;
    await h.coordinator.retryWaiting(); expect(h.run).not.toHaveBeenCalled(); expect(h.coordinator.pendingWaiting()).toEqual([]);
  });
  it("waits without provider calls, resumes each consumer exactly once and keeps click-time parameters", async () => {
    const h = fixture(), a = h.input(), b = h.input("image-b"), frozen = h.freeze();
    expect(await h.coordinator.submit(a)).toMatchObject({ ok: false, waiting: true });
    expect(await h.coordinator.submit(b)).toMatchObject({ ok: false, waiting: true });
    a.parameters.strength = 99; expect(h.run).not.toHaveBeenCalled();
    h.ready(frozen[0]!);
    await Promise.all([h.coordinator.retryWaiting(), h.coordinator.retryWaiting()]);
    expect(h.run).toHaveBeenCalledTimes(2);
    expect(h.run.mock.calls[0]![0]).toMatchObject({ parameters: { strength: 1 }, shotImageReferences: [{ contentIdentity: frozen[0]!.contentIdentity }] });
    expect(h.coordinator.pendingWaiting()).toEqual([]); await h.coordinator.retryWaiting(); expect(h.run).toHaveBeenCalledTimes(2);
  });
  it("A cannot be replaced by B; an already ready A stays usable after a source edit", async () => {
    const h = fixture(), frozen = h.freeze();
    await h.coordinator.submit(h.input());
    const changed = structuredClone(h.snapshot); changed.filmSetAnimations!.clips[0]!.initialCamera.azimuth += 1;
    h.canvas.nodeData.film = canonicalFilmSetFields(changed) as never;
    expect(await h.coordinator.retryWaiting()).toMatchObject([{ ok: false, error: expect.stringContaining("shot-image-version-stale") }]);
    expect(h.run).not.toHaveBeenCalled();
    h.canvas.nodeData.film = canonicalFilmSetFields(h.snapshot) as never;
    await h.coordinator.submit(h.input()); h.ready(frozen[0]!);
    h.canvas.nodeData.film = canonicalFilmSetFields(changed) as never;
    await h.coordinator.retryWaiting(); expect(h.run).toHaveBeenCalledOnce();
    expect(h.run.mock.calls[0]![0]).toMatchObject({ shotImageReferences: [{ contentIdentity: frozen[0]!.contentIdentity }] });
  });
  it.each(["reconnect", "delete", "canvas-switch", "cancel", "unsupported"])("%s cancels or refuses waiting without a provider call", async mode => {
    const h = fixture(), input = h.input();
    if (mode === "unsupported") input.catalog.models[0]!.bindings = [];
    await h.coordinator.submit(input);
    if (mode === "reconnect") h.canvas.nodeData["image-a"]!.inputMapping![0]!.sourceNodeId = "another-preview";
    if (mode === "delete") h.canvas.document.nodes = h.canvas.document.nodes.filter(node => node.id !== "image-a");
    if (mode === "canvas-switch") h.changeCanvas({ ...h.canvas, id: "other" });
    if (mode === "cancel") await h.coordinator.cancel({ nodeId: "image-a", runId: "waiting" });
    await h.coordinator.retryWaiting(); expect(h.run).not.toHaveBeenCalled(); expect(h.coordinator.pendingWaiting()).toEqual([]);
  });
});
