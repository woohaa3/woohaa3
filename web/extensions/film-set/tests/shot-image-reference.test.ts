import { migrateFilmSetFixture } from "../../../test-support/film-set-groups.js";
import { CompositeAssetRegistry } from "@woohaa3/frontend/extension-api";
import { applyCanvasCommands } from "../../../test-support/managed-shot-commands.js";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalFilmSetFields, createEmptyWoohaa3ServerCanvas, createFilmSetSnapshot, createMotionSnapshot, type CanvasCommand, type StoredAsset } from "@woohaa3/contracts";
import { installShotImageReferences, type ShotImageReferences } from "../src/authoring/browser/shot-image-reference.js";
import type { FilmSetHostContext } from "../src/state/browser/host-ports.js";

const owners: ShotImageReferences[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.unstubAllGlobals(); });

function fixture() {
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => { queueMicrotask(fn); return 1; });
  vi.stubGlobal("ImageData", class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
  vi.stubGlobal("OffscreenCanvas", class { getContext() { return { putImageData() {} }; } async convertToBlob() { return new Blob(["png"], { type: "image/png" }); } });
  let canvas = createEmptyWoohaa3ServerCanvas("still-canvas");
  const animation = createFilmSetSnapshot({ title: "Film", model: { modelScript: 'scene.box({id:"body"});', modelScriptVersion: "woohaa-model-js-v2" }, motionScript: 'motion.model.rotate("body", {speed:1});', timeline: { duration: 4, loop: false } });
  animation.filmSetAnimations!.clips[0] = { ...animation.filmSetAnimations!.clips[0]!, kind: "static", timeline: { duration: 0, loop: false }, bindings: [], cameraMotion: createMotionSnapshot({ motionScript: "", basedOnModelVersion: { revision: 1, sourceHash: "camera", contentHash: "camera" } }) };
  canvas.document.nodes.push({ id: "film", type: "composite-asset", position: { x: 0, y: 0 } });
  canvas.nodeData.film = canonicalFilmSetFields(animation) as never;
  canvas = migrateFilmSetFixture(canvas, "film");
  const materialized = applyCanvasCommands(canvas, [{ type: "canvas.setTitle", title: "Still" }]);
  if (!materialized.ok) throw new Error(materialized.rejection.message); canvas = materialized.canvas;
  let focused = true, writable = true, rejectRegistration = false, holdRegistration = false;
  let settle: (() => void) | undefined;
  const subscriptions = new Set<() => void>(), navigation = new Set<() => void>();
  const release = vi.fn(), restore = vi.fn(), beginStillCapture = vi.fn(() => restore);
  const capture = vi.fn(async ({ width, height }: { width: number; height: number }) => ({ width, height, rgba: new Uint8Array(width * height * 4) }));
  const upload = vi.fn(async () => ({ ok: true, media: { storageKey: "images/still.png", url: "/api/media/images/still.png", checksum: "a".repeat(64), size: 3 } }));
  const waitForTime = vi.fn(async () => true), commands: CanvasCommand[] = [];
  const ctx = {
    compositeAssets: new CompositeAssetRegistry(),
    canvasState: { getCanvas: () => canvas, getWorkingCanvas: () => { throw new Error("must read committed source"); }, subscribe: (fn: () => void) => { subscriptions.add(fn); return () => subscriptions.delete(fn); } },
    canvasNavigation: { getSnapshot: () => ({ mode: focused ? { type: "node-focus", nodeId: "film" } : { type: "canvas" } }), subscribe: (fn: () => void) => { navigation.add(fn); return () => navigation.delete(fn); } },
    modelWorkspace: { acquireCapture: async () => release },
    canvasRuntime: { runtime: () => ({ isReady: () => true, requestCapture: capture }), compositeAssetMediaSessions: () => ({ waitForTime }) },
    mediaRemote: { upload },
    canvasSession: { isWritable: () => writable, submitCommands: (batch: CanvasCommand[]) => {
      commands.push(...batch);
      return { ok: true, handle: { settled: new Promise(resolve => {
        const finish = () => {
          if (rejectRegistration) { resolve({ state: "rejected", error: "registration temporarily offline" }); return; }
          for (const command of batch) if (command.type === "asset.upsert") canvas.assets.push(command.asset);
          resolve({ state: "committed" });
        };
        if (holdRegistration) settle = finish; else finish();
      }) } };
    } },
  } as unknown as FilmSetHostContext;
  const owner = installShotImageReferences(ctx, { beginStillCapture }); owners.push(owner);
  return { owner, canvas, capture, upload, reinstall: () => { const restored = installShotImageReferences(ctx, { beginStillCapture }); owners.push(restored); return restored; }, waitForTime, beginStillCapture, release, restore, commands,
    leave: () => { focused = false; navigation.forEach(fn => fn()); },
    notify: () => subscriptions.forEach(fn => fn()),
    hold: (value: boolean) => { holdRegistration = value; }, reject: (value: boolean) => { rejectRegistration = value; },
    settle: () => settle?.(), readonly: () => { writable = false; subscriptions.forEach(fn => fn()); } };
}

describe("owner-managed static PNG preparation", () => {
  it("focus only marks dirty; T=0 capture uploads one image and waits for authoritative registration", async () => {
    const h = fixture(); h.hold(true);
    expect(h.owner.state("film", "clip-1").status).toBe("dirty"); expect(h.capture).not.toHaveBeenCalled();
    h.leave(); await vi.waitFor(() => expect(h.upload).toHaveBeenCalledTimes(1));
    expect(h.owner.state("film", "clip-1").status).toBe("preparing");
    expect(h.waitForTime).toHaveBeenCalledWith("film", 0, 5000, .001);
    const asset = (h.commands.find(command => command.type === "asset.upsert") as { asset: StoredAsset }).asset;
    expect(asset).toMatchObject({ mediaKind: "image", url: "/api/media/images/still.png", metadata: { contentType: "image/png", width: 1280, height: 720 } });
    expect(asset.id).toMatch(/^shot-reference-image:/);
    expect(h.commands.some(command => command.type === "job.upsert" || command.type === "node.add")).toBe(false);
    h.settle(); await vi.waitFor(() => expect(h.owner.state("film", "clip-1").status).toBe("ready"));
    h.notify(); expect(h.upload).toHaveBeenCalledTimes(1); expect(h.release).toHaveBeenCalledOnce(); expect(h.restore).toHaveBeenCalledOnce();
  });
  it("registration retry reuses uploaded bytes and refresh hydrates canonical assets", async () => {
    const h = fixture(); h.reject(true); h.leave();
    await vi.waitFor(() => expect(h.owner.state("film", "clip-1").status).toBe("failed"));
    const captures = h.capture.mock.calls.length;
    h.reject(false); h.owner.retry("film", "clip-1");
    await vi.waitFor(() => expect(h.owner.state("film", "clip-1").status).toBe("ready"));
    expect(h.upload).toHaveBeenCalledOnce(); expect(h.capture).toHaveBeenCalledTimes(captures);
    h.owner.dispose();
    const restored = h.reinstall();
    expect(restored.state("film", "clip-1").status).toBe("ready");
    expect(h.capture).toHaveBeenCalledTimes(captures); expect(h.upload).toHaveBeenCalledOnce();
  });
  it("permission loss before acknowledgement prevents stale publication and releases capture", async () => {
    const h = fixture(); h.hold(true); h.leave();
    await vi.waitFor(() => expect(h.upload).toHaveBeenCalledOnce());
    h.readonly(); h.reject(true); h.settle(); await Promise.resolve(); await Promise.resolve();
    expect(h.owner.state("film", "clip-1").status).not.toBe("ready");
    expect(h.release).toHaveBeenCalledOnce(); expect(h.restore).toHaveBeenCalledOnce();
  });
});
