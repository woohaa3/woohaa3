import { describe, expect, it } from "vitest";
import { WORLD_CAPTURE_GENERATION_BINDING_VERSION } from "../canvas/world-capture-pipeline-contract.js";
import type { WorldCaptureGenerationBinding } from "../canvas/world-capture-pipeline-contract.js";
import {
  WORLD_CAPTURE_REFERENCE_ROLE,
  withWorldCaptureTaskInput,
  worldCaptureReferenceInput
} from "./world-capture-input.js";

const KEY = {
  canvasId: "canvas-1",
  cameraId: "camera-1",
  worldContentVersion: "world-1",
  cameraSettingsVersion: "camera-1-v1",
  bindingVersion: "binding-1",
  outputVersion: "output-1"
} as const;

const MEDIA = {
  version: "world-capture-media-v2" as const,
  mediaId: "generation-outputs/capture.png",
  storageKey: "generation-outputs/capture.png",
  checksum: "a".repeat(64),
  contentType: "image/png",
  size: 1024,
  width: 16,
  height: 9
};

const BINDING: WorldCaptureGenerationBinding = {
  version: WORLD_CAPTURE_GENERATION_BINDING_VERSION,
  requestId: "request-1",
  key: KEY,
  contentFingerprint: "0123456789abcdef",
  input: { key: KEY, mediaId: MEDIA.mediaId, checksum: MEDIA.checksum },
  media: MEDIA
};

describe("world capture task reference input", () => {
  it("materializes the exact frozen media as a normal reference image", () => {
    const result = worldCaptureReferenceInput(BINDING);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input).toEqual({
      assetId: MEDIA.mediaId,
      role: WORLD_CAPTURE_REFERENCE_ROLE,
      storageKey: MEDIA.storageKey,
      mediaType: MEDIA.contentType,
      mediaKind: "image"
    });
  });

  it("fails closed without verified media or with mismatched identity", () => {
    const withoutMedia: WorldCaptureGenerationBinding = { ...BINDING, media: undefined };
    expect(worldCaptureReferenceInput(withoutMedia)).toMatchObject({ ok: false, code: "capture-media-unavailable" });
    expect(
      worldCaptureReferenceInput({ ...BINDING, media: { ...MEDIA, checksum: "b".repeat(64) } })
    ).toMatchObject({ ok: false, code: "capture-media-unavailable" });
  });

  it("appends exactly once and preserves caller order", () => {
    const existing = {
      assetId: "asset-1",
      role: "reference_image",
      storageKey: "generation-outputs/existing.png",
      mediaType: "image/png",
      mediaKind: "image" as const
    };
    const once = withWorldCaptureTaskInput([existing], BINDING);
    expect(once.map((input) => input.storageKey)).toEqual([
      "generation-outputs/existing.png",
      MEDIA.storageKey
    ]);
    expect(withWorldCaptureTaskInput(once, BINDING)).toEqual(once);
    expect(withWorldCaptureTaskInput([existing], undefined)).toEqual([existing]);
  });
});

describe("动态镜头视频绑定", () => {
  const VIDEO_KEY = { ...KEY, outputVersion: "output-video" };
  const VIDEO_MEDIA = {
    version: "world-capture-video-media-v1" as const,
    mediaId: "sha256-video",
    storageKey: `capture-videos/${"b".repeat(64)}.mp4`,
    checksum: "b".repeat(64),
    size: 2048,
    contentType: "video/mp4",
    width: 1024,
    height: 576,
    container: "video/mp4" as const,
    durationSeconds: 4,
    fps: 24
  };

  it("v2 视频绑定解析为 reference_video，而不是图片", () => {
    const binding: WorldCaptureGenerationBinding = {
      version: WORLD_CAPTURE_GENERATION_BINDING_VERSION,
      requestId: "request-video",
      key: VIDEO_KEY,
      contentFingerprint: "0123456789abcdef",
      input: { key: VIDEO_KEY, mediaId: VIDEO_MEDIA.mediaId, checksum: VIDEO_MEDIA.checksum },
      video: VIDEO_MEDIA
    };
    expect(worldCaptureReferenceInput(binding)).toMatchObject({
      ok: true,
      input: {
        assetId: VIDEO_MEDIA.mediaId,
        role: "reference_video",
        mediaKind: "video",
        mediaType: "video/mp4",
        storageKey: VIDEO_MEDIA.storageKey
      }
    });
    // 图片元数据不能冒充视频，反之亦然。
    expect(worldCaptureReferenceInput({ ...binding, video: { ...VIDEO_MEDIA, contentType: "image/png" } }))
      .toMatchObject({ ok: false, code: "capture-media-unavailable" });
  });
});
