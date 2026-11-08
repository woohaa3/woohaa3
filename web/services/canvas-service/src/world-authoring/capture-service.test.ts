import { describe, expect, it, vi } from "vitest";
import {
  SHARED_WORLD_VERSION,
  createDefaultWorldCameraData,
  createEmptyWoohaa3ServerCanvas,
  createWorldAnimationScript,
  type ServerCanvas,
  type WorldCaptureDynamicMediaSaveRequest,
  type WorldCaptureDynamicSaveResult
} from "@woohaa3/contracts";
import { createWorldCaptureService } from "./capture-service.js";

/** 动画区内的镜头 → 动态取景；验证冻结不会被自己的版本判为 superseded。 */
function animatedCanvas(): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas", "2026-11-05T00:00:00Z");
  canvas.document.nodes.push({ id: "camera", type: "world-camera", position: { x: 0, y: 0 } });
  canvas.nodeData.camera = {
    worldCamera: {
      ...createDefaultWorldCameraData("camera", "v1", { u: 0, v: 8 }),
      captureMode: { kind: "static" }
    }
  } as never;
  canvas.document.nodes.push({ id: "area", type: "scene-area" });
  canvas.nodeData.area = {
    sceneArea: {
      kind: "scene-area",
      version: SHARED_WORLD_VERSION,
      areaId: "area-1",
      scopeVersion: "scope-1",
      bounds: { min: { u: -30, v: -30 }, max: { u: 30, v: 30 } },
      animationScript: createWorldAnimationScript({
        script: "function build(motion) {}",
        duration: 4,
        loop: false
      })
    }
  } as never;
  return canvas;
}

function videoSavePort(bytesLength: number) {
  return {
    async save(request: WorldCaptureDynamicMediaSaveRequest): Promise<WorldCaptureDynamicSaveResult> {
      return {
        status: "saved",
        requestId: request.requestId,
        key: request.key,
        contentFingerprint: request.contentFingerprint,
        media: {
          version: "world-capture-video-media-v1",
          mediaId: "media-1",
          storageKey: "capture-videos/media-1.mp4",
          checksum: "a".repeat(64),
          size: bytesLength,
          contentType: "video/mp4",
          width: request.video.width,
          height: request.video.height,
          container: "video/mp4",
          durationSeconds: request.video.durationSeconds,
          fps: request.video.fps
        }
      };
    }
  };
}

describe("动态取景冻结", () => {
  it("page consumers share an in-flight attempt and cancelling one does not supersede its result", async () => {
    vi.useFakeTimers();
    const canvas = animatedCanvas();
    const bytes = new Uint8Array([1, 2, 3]);
    const service = createWorldCaptureService({
      resolveRoom: async () => ({ exportCanvas: () => ({ ok: true, canvas }) }) as never,
      videoMediaSave: videoSavePort(bytes.length), freezeTimeoutMs: 1000
    });
    try {
      service.observeCanonical({ canvasId: canvas.id, canvas });
      const pending = service.pendingPageCaptures(canvas.id)[0]!;
      const abort = new AbortController();
      const first = service.freezeForGeneration({ canvasId: canvas.id, cameraId: "camera", signal: abort.signal });
      const second = service.freezeForGeneration({ canvasId: canvas.id, cameraId: "camera" });
      await vi.advanceTimersByTimeAsync(0);
      expect(service.pendingPageCaptures(canvas.id)[0]!.attemptId).toBe(pending.attemptId);
      abort.abort();
      await vi.advanceTimersByTimeAsync(100);
      expect(await first).toMatchObject({ ok: false, code: "cancelled" });
      expect(await service.commitPageVideoCapture({ canvasId: canvas.id, cameraId: "camera", attemptId: pending.attemptId,
        key: pending.dynamicKey!, video: { bytes, contentType: "video/mp4", width: pending.width,
          height: pending.height, durationSeconds: 4, fps: pending.dynamicKey!.fps } })).toMatchObject({ ok: true });
      await vi.advanceTimersByTimeAsync(100);
      expect(await second).toMatchObject({ ok: true });
    } finally { service.dispose(); vi.useRealTimers(); }
  });

  it("preparing a failed static page capture starts a new attempt that accepts progress", async () => {
    const canvas = animatedCanvas();
    canvas.document.nodes = canvas.document.nodes.filter(node => node.id !== "area");
    delete canvas.nodeData.area;
    const service = createWorldCaptureService({
      resolveRoom: async () => ({ exportCanvas: () => ({ ok: true, canvas }) }) as never
    });
    try {
      const first = await service.preparePageCapture({ canvasId: canvas.id, cameraId: "camera" });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      service.reportPageProgress(canvas.id, { cameraId: "camera", attemptId: first.attemptId, stage: "failed" });
      const second = await service.preparePageCapture({ canvasId: canvas.id, cameraId: "camera" });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.attemptId).not.toBe(first.attemptId);
      expect(service.reportPageProgress(canvas.id, { cameraId: "camera", attemptId: second.attemptId, stage: "rendering" })).toBe(true);
      expect(service.reportPageProgress(canvas.id, { cameraId: "camera", attemptId: first.attemptId, stage: "uploading" })).toBe(false);
    } finally { service.dispose(); }
  });

  it("one consumer timing out does not cancel another consumer's shared recording", async () => {
    vi.useFakeTimers();
    const canvas = animatedCanvas();
    const bytes = new Uint8Array([1, 2, 3]);
    const service = createWorldCaptureService({
      resolveRoom: async () => ({ exportCanvas: () => ({ ok: true, canvas }) }) as never,
      videoMediaSave: videoSavePort(bytes.length), freezeTimeoutMs: 200
    });
    let complete!: () => void;
    const captureVideo = vi.fn(async (request: import("@woohaa3/contracts").WorldCaptureDynamicRequest, options?: { readonly signal?: AbortSignal }) => {
      await new Promise<void>(resolve => { complete = resolve; });
      expect(options?.signal?.aborted).toBe(false);
      return { status: "video" as const, requestId: request.requestId, key: request.key, contentFingerprint: request.contentFingerprint,
        video: { bytes, contentType: "video/mp4" as const, width: request.output.width, height: request.output.height,
          durationSeconds: 4, fps: request.key.fps } };
    });
    service.registerVideoProducer({ producerId: "slow", captureVideo });
    try {
      const first = service.freezeForGeneration({ canvasId: canvas.id, cameraId: "camera" });
      await vi.advanceTimersByTimeAsync(100);
      const second = service.freezeForGeneration({ canvasId: canvas.id, cameraId: "camera" });
      await vi.advanceTimersByTimeAsync(100);
      expect(await first).toMatchObject({ ok: false, code: "timeout" });
      complete();
      await vi.advanceTimersByTimeAsync(0);
      expect(await second).toMatchObject({ ok: true });
      expect(captureVideo).toHaveBeenCalledOnce();
    } finally { service.dispose(); vi.useRealTimers(); }
  });

  it("同一版本可以重复冻结并返回视频 binding，不会误判 superseded", async () => {
    const canvas = animatedCanvas();
    const room = {
      exportCanvas: () => ({ ok: true as const, canvas }),
      revision: canvas.revision
    };
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const service = createWorldCaptureService({
      resolveRoom: async () => room as never,
      videoMediaSave: videoSavePort(bytes.length),
      claimTtlMs: 60_000
    });
    service.registerVideoProducer({
      producerId: "test-video",
      async captureVideo(request) {
        return {
          status: "video",
          requestId: request.requestId,
          key: request.key,
          contentFingerprint: request.contentFingerprint,
          video: {
            bytes,
            contentType: "video/mp4",
            width: request.output.width,
            height: request.output.height,
            durationSeconds: request.key.timeRange.endSeconds - request.key.timeRange.startSeconds,
            fps: request.key.fps
          }
        };
      }
    });

    const refreshed = await service.refresh({ canvasId: canvas.id, cameraId: "camera" });
    expect(refreshed.ok).toBe(true);
    const status = service.status({ canvasId: canvas.id, cameraId: "camera" });
    expect(status).toMatchObject({ phase: "ready", shotKind: "dynamic", stale: false });
    expect(status.video?.contentType).toBe("video/mp4");
    expect(status.dynamicKey).toMatchObject({
      animation: { areaId: "area-1", durationSeconds: 4 },
      timeRange: { startSeconds: 0, endSeconds: 4 }, fps: 24
    });

    const frozen = await service.freezeForGeneration({ canvasId: canvas.id, cameraId: "camera" });
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    expect(frozen.binding.video?.mediaId).toBe("media-1");
    expect(frozen.binding.input.mediaId).toBe("media-1");
    service.dispose();
  });
});

it("page progress can exceed the total wait limit but a stalled attempt expires and retries get a new identity", async () => {
  let now = 1000;
  const canvas = animatedCanvas();
  const service = createWorldCaptureService({ now: () => now,
    resolveRoom: async () => ({ exportCanvas: () => ({ ok: true, canvas }) }) as never });
  service.observeCanonical({ canvasId: canvas.id, canvas });
  const first = service.pendingPageCaptures(canvas.id)[0]!;
  for (let frame = 1; frame <= 4; frame++) {
    now += 80_000;
    expect(service.reportPageProgress(canvas.id, { cameraId: "camera", attemptId: first.attemptId!, stage: "rendering", completedFrames: frame, totalFrames: 96 })).toBe(true);
    expect(service.status({ canvasId: canvas.id, cameraId: "camera" }).phase).toBe("waiting");
  }
  now += 91_000;
  expect(service.status({ canvasId: canvas.id, cameraId: "camera" })).toMatchObject({ phase: "failed", reason: "page-capture-stalled" });
  expect(service.reportPageProgress(canvas.id, { cameraId: "camera", attemptId: first.attemptId!, stage: "uploading" })).toBe(false);
  await service.refresh({ canvasId: canvas.id, cameraId: "camera" });
  const second = service.pendingPageCaptures(canvas.id)[0]!;
  expect(second.attemptId).not.toBe(first.attemptId);
  now += 91_000;
  expect(service.status({ canvasId: canvas.id, cameraId: "camera" })).toMatchObject({ phase: "failed", reason: "page-unavailable" });
  service.dispose();
});
