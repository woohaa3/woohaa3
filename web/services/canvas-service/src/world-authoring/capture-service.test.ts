import { describe, expect, it } from "vitest";
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

    const frozen = await service.freezeForGeneration({ canvasId: canvas.id, cameraId: "camera" });
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    expect(frozen.binding.video?.mediaId).toBe("media-1");
    expect(frozen.binding.input.mediaId).toBe("media-1");
    service.dispose();
  });
});
