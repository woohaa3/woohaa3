import { describe, expect, it } from "vitest";
import { SHARED_WORLD_VERSION } from "./shared-world.js";
import { worldCaptureContentFingerprint } from "./world-capture-content-contract.js";
import {
  WORLD_CAPTURE_DYNAMIC_CONTAINER,
  WORLD_CAPTURE_DYNAMIC_REQUEST_VERSION,
  WORLD_CAPTURE_VIDEO_MEDIA_VERSION,
  createWorldCaptureDynamicRequest,
  decodeWorldCaptureVideoMediaMetadata,
  freezeWorldCaptureVideoInput,
  planWorldCaptureDynamicAttempt,
  resolveWorldCaptureDynamicOutcome,
  worldCaptureDynamicBaseKey,
  worldCaptureDynamicFrameCount,
  worldCaptureDynamicKeysEqual,
  worldCaptureDynamicRequestIdentity,
  worldCaptureDynamicVersionSignature,
  worldCaptureFrameTime,
  type WorldCaptureDynamicProducerOutcome,
  type WorldCaptureDynamicRequest,
  type WorldCaptureVideoMediaMetadata
} from "./world-capture-dynamic-contract.js";

function camera(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "world-camera",
    version: SHARED_WORLD_VERSION,
    cameraId: "camera-1",
    settingsVersion: "settings-1",
    position: { u: 0, v: 0, h: 1.8 },
    rotation: [0, 0, 0, 1],
    projection: { kind: "perspective", verticalFovRadians: Math.PI / 3, nearMeters: 0.1, farMeters: 80 },
    captureMode: { kind: "dynamic" },
    aspect: { width: 16, height: 9 },
    boundInstanceId: null,
    ...overrides
  };
}

function key(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    canvasId: "canvas-1",
    cameraId: "camera-1",
    worldContentVersion: "world-1",
    cameraSettingsVersion: "settings-1",
    bindingVersion: "binding-1",
    outputVersion: "output-1",
    animation: { areaId: "area-1", scriptRevision: 3, sourceHash: "hash-1", durationSeconds: 4 },
    timeRange: { startSeconds: 0, endSeconds: 4 },
    fps: 24,
    ...overrides
  };
}

function requestInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: WORLD_CAPTURE_DYNAMIC_REQUEST_VERSION,
    requestId: "request-1",
    key: key(),
    camera: camera(),
    subject: { kind: "world", instances: [], contents: [] },
    output: { outputVersion: "output-1", width: 1024, height: 576, container: WORLD_CAPTURE_DYNAMIC_CONTAINER },
    contentFingerprint: worldCaptureContentFingerprint([]),
    ...overrides
  };
}

function decodeRequest(overrides: Record<string, unknown> = {}): WorldCaptureDynamicRequest {
  const decoded = createWorldCaptureDynamicRequest(requestInput(overrides));
  if (!decoded.ok) throw new Error(`expected decode, got ${decoded.code}`);
  return decoded.value;
}

function rawMedia(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: WORLD_CAPTURE_VIDEO_MEDIA_VERSION,
    mediaId: "media-1",
    storageKey: "sha256-media-1",
    checksum: "a".repeat(64),
    size: 4,
    contentType: "video/mp4",
    width: 1024,
    height: 576,
    container: WORLD_CAPTURE_DYNAMIC_CONTAINER,
    durationSeconds: 4,
    fps: 24,
    ...overrides
  };
}

function media(overrides: Record<string, unknown> = {}): WorldCaptureVideoMediaMetadata {
  const decoded = decodeWorldCaptureVideoMediaMetadata(rawMedia(overrides));
  if (!decoded.ok) throw new Error(`expected video metadata, got ${decoded.code}`);
  return decoded.value;
}

function videoOutcome(request: WorldCaptureDynamicRequest): Extract<WorldCaptureDynamicProducerOutcome, { status: "video" }> {
  return {
    status: "video",
    requestId: request.requestId,
    key: request.key,
    contentFingerprint: request.contentFingerprint,
    video: {
      bytes: new Uint8Array([1, 2, 3, 4]),
      contentType: "video/mp4",
      width: 1024,
      height: 576,
      durationSeconds: 4,
      fps: 24
    }
  };
}

describe("动态取景请求契约", () => {
  it("接受合法请求并冻结全部字段", () => {
    const request = decodeRequest();
    expect(request.key.animation).toMatchObject({ areaId: "area-1", scriptRevision: 3, sourceHash: "hash-1" });
    expect(request.key.timeRange).toEqual({ startSeconds: 0, endSeconds: 4 });
    expect(request.key.fps).toBe(24);
    expect(request.output.container).toBe("video/mp4");
    expect(worldCaptureDynamicFrameCount(request.key)).toBe(96);
    expect(worldCaptureFrameTime(request.key, 24)).toBe(1);
  });

  it("拒绝未知字段", () => {
    const withExtra = requestInput({ unknown: true });
    expect(createWorldCaptureDynamicRequest(withExtra)).toMatchObject({ ok: false, code: "invalid-data" });
  });

  it("拒绝非法区间", () => {
    const inverted = requestInput({ key: key({ timeRange: { startSeconds: 3, endSeconds: 3 } }) });
    expect(createWorldCaptureDynamicRequest(inverted)).toMatchObject({ ok: false, code: "invalid-data" });
    const negative = requestInput({ key: key({ timeRange: { startSeconds: -1, endSeconds: 2 } }) });
    expect(createWorldCaptureDynamicRequest(negative)).toMatchObject({ ok: false, code: "invalid-data" });
  });

  it("超限区间显式拒绝而不是静默截断", () => {
    const long = requestInput({
      key: key({
        animation: { areaId: "area-1", scriptRevision: 3, sourceHash: "hash-1", durationSeconds: 120 },
        timeRange: { startSeconds: 0, endSeconds: 61 }
      })
    });
    expect(createWorldCaptureDynamicRequest(long)).toMatchObject({ ok: false, code: "duration-exceeded" });
  });

  it("拒绝越界 fps", () => {
    expect(createWorldCaptureDynamicRequest(requestInput({ key: key({ fps: 0 }) })))
      .toMatchObject({ ok: false, code: "fps-out-of-range" });
    expect(createWorldCaptureDynamicRequest(requestInput({ key: key({ fps: 61 }) })))
      .toMatchObject({ ok: false, code: "fps-out-of-range" });
    expect(createWorldCaptureDynamicRequest(requestInput({ key: key({ fps: 23.5 }) })))
      .toMatchObject({ ok: false, code: "fps-out-of-range" });
  });

  it("拒绝非 mp4 容器", () => {
    const input = requestInput({
      output: { outputVersion: "output-1", width: 1024, height: 576, container: "video/webm" }
    });
    expect(createWorldCaptureDynamicRequest(input)).toMatchObject({ ok: false, code: "unsupported-container" });
  });
});

describe("视频媒体元数据", () => {
  it("正反 fixture 与跨版本拒绝", () => {
    expect(media()).toMatchObject({ contentType: "video/mp4", durationSeconds: 4, fps: 24 });
    expect(decodeWorldCaptureVideoMediaMetadata(rawMedia({ contentType: "image/png" })))
      .toMatchObject({ ok: false, code: "invalid-data" });
    expect(decodeWorldCaptureVideoMediaMetadata(rawMedia({ version: "world-capture-media-v2" })))
      .toMatchObject({ ok: false, code: "unsupported-version" });
    const withoutFps = rawMedia();
    delete (withoutFps as unknown as Record<string, unknown>).fps;
    expect(decodeWorldCaptureVideoMediaMetadata(withoutFps)).toMatchObject({ ok: false, code: "invalid-data" });
  });
});

describe("key 相等、freeze、wait、cancel、replace", () => {
  it("同键相等、异键不等", () => {
    const request = decodeRequest();
    expect(worldCaptureDynamicKeysEqual(request.key, request.key)).toBe(true);
    expect(
      worldCaptureDynamicKeysEqual(
        request.key,
        decodeRequest({ key: key({ timeRange: { startSeconds: 0, endSeconds: 3 } }) }).key
      )
    ).toBe(false);
    expect(worldCaptureDynamicBaseKey(request.key).outputVersion).toBe("output-1");
  });

  it("只有当前键才能 freeze", () => {
    const request = decodeRequest();
    expect(freezeWorldCaptureVideoInput(request.key, request.key, media())).toMatchObject({ ok: true });
    const other = decodeRequest({ key: key({ fps: 30 }) }).key;
    expect(freezeWorldCaptureVideoInput(request.key, other, media())).toMatchObject({ ok: false, code: "superseded" });
  });

  it("迟到旧结果不发布", () => {
    const request = decodeRequest();
    const current = decodeRequest({ key: key({ timeRange: { startSeconds: 0, endSeconds: 3 } }) }).key;
    const resolution = resolveWorldCaptureDynamicOutcome({
      request,
      currentKey: current,
      cancelled: false,
      outcome: videoOutcome(request)
    });
    expect(resolution.status).toBe("superseded");
  });

  it("取消后不发布", () => {
    const request = decodeRequest();
    const resolution = resolveWorldCaptureDynamicOutcome({
      request,
      currentKey: request.key,
      cancelled: true,
      outcome: videoOutcome(request),
      saved: {
        status: "saved",
        requestId: request.requestId,
        key: request.key,
        contentFingerprint: request.contentFingerprint,
        media: media()
      }
    });
    expect(resolution.status).toBe("cancelled");
  });

  it("替换后旧键不可 ready", () => {
    const request = decodeRequest();
    const resolution = resolveWorldCaptureDynamicOutcome({
      request,
      currentKey: request.key,
      cancelled: false,
      outcome: { ...videoOutcome(request), key: decodeRequest({ key: key({ fps: 30 }) }).key }
    });
    expect(resolution).toMatchObject({ status: "rejected", code: "request-mismatch" });
  });

  it("校验通过的保存结果才 ready", () => {
    const request = decodeRequest();
    const pending = resolveWorldCaptureDynamicOutcome({
      request,
      currentKey: request.key,
      cancelled: false,
      outcome: videoOutcome(request)
    });
    expect(pending.status).toBe("media-required");

    const ready = resolveWorldCaptureDynamicOutcome({
      request,
      currentKey: request.key,
      cancelled: false,
      outcome: videoOutcome(request),
      saved: {
        status: "saved",
        requestId: request.requestId,
        key: request.key,
        contentFingerprint: request.contentFingerprint,
        media: media()
      }
    });
    expect(ready.status).toBe("ready");
    if (ready.status === "ready") {
      expect(ready.frozen.input.mediaId).toBe("media-1");
      expect(ready.frozen.key.outputVersion).toBe("output-1");
    }

    const mismatched = resolveWorldCaptureDynamicOutcome({
      request,
      currentKey: request.key,
      cancelled: false,
      outcome: videoOutcome(request),
      saved: {
        status: "saved",
        requestId: request.requestId,
        key: request.key,
        contentFingerprint: request.contentFingerprint,
        media: media({ durationSeconds: 1 })
      }
    });
    expect(mismatched).toMatchObject({ status: "rejected", code: "media-unverified" });
  });

  it("等待与失败原因保留", () => {
    const request = decodeRequest();
    const waiting = resolveWorldCaptureDynamicOutcome({
      request,
      currentKey: request.key,
      cancelled: false,
      outcome: {
        status: "waiting",
        requestId: request.requestId,
        key: request.key,
        contentFingerprint: request.contentFingerprint,
        reason: "renderer-unavailable"
      }
    });
    expect(waiting).toMatchObject({ status: "waiting", reason: "renderer-unavailable" });
  });
});

describe("请求身份与重试幂等", () => {
  it("同 key 复用字节与登记，不同 key 不复用", () => {
    const request = decodeRequest();
    const identity = worldCaptureDynamicRequestIdentity(request.key);
    expect(identity).toBe(`world-capture-dynamic:${worldCaptureDynamicVersionSignature(request.key)}`);
    const first = planWorldCaptureDynamicAttempt({ key: request.key });
    expect(first).toMatchObject({ requestId: identity, reuseBytes: false, mediaId: null });

    const reused = planWorldCaptureDynamicAttempt({
      key: request.key,
      existing: { identity, mediaId: "media-1" }
    });
    expect(reused).toMatchObject({ requestId: identity, reuseBytes: true, mediaId: "media-1" });

    const other = decodeRequest({ key: key({ fps: 30 }) }).key;
    const changed = planWorldCaptureDynamicAttempt({
      key: other,
      existing: { identity, mediaId: "media-1" }
    });
    expect(changed.reuseBytes).toBe(false);
    expect(changed.requestId).not.toBe(identity);
  });
});
