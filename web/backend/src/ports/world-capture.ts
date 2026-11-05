/**
 * Backend wiring for the T10 capture media port.
 *
 * Canvas never holds storage credentials or bytes; this adapter gives the capture
 * service only the narrow Media Service import/verify calls it needs. It is defined
 * in the backend (not re-exported from canvas-service) so backend host tests can keep
 * using their existing canvas-service mock without a new runtime export.
 */
import type {
  BackendMediaPort,
  WorldCaptureDynamicMediaSaveRequest,
  WorldCaptureDynamicSaveResult,
  WorldCaptureMediaMetadata,
  WorldCaptureMediaSavePort,
  WorldCaptureMediaSaveRequest,
  WorldCaptureMediaSaveResult,
  WorldCaptureVideoMediaSavePort
} from "@woohaa3/contracts";
import {
  WORLD_CAPTURE_VIDEO_MEDIA_VERSION,
  isInspectableWorldCaptureContentType,
  readWorldCaptureImageDimensions,
  readWorldCaptureVideoInfo
} from "@woohaa3/contracts";

const DEFAULT_MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

export function createCaptureMediaSavePort(
  media: BackendMediaPort,
  options: { maxBytes?: number } = {}
): WorldCaptureMediaSavePort {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
  return {
    async save(request: WorldCaptureMediaSaveRequest): Promise<WorldCaptureMediaSaveResult> {
      const { image } = request;
      if (
        image.bytes.length === 0 ||
        image.bytes.length > maxBytes ||
        !isInspectableWorldCaptureContentType(image.contentType)
      ) {
        return failed(request, "verification-failed");
      }
      const dimensions = readWorldCaptureImageDimensions(image.bytes, image.contentType);
      if (!dimensions || dimensions.width !== image.width || dimensions.height !== image.height) {
        return failed(request, "verification-failed");
      }

      let imported: { storageKey: string; contentType: string; size: number; checksum: string };
      try {
        imported = await media.importBytes({
          bytesBase64: Buffer.from(image.bytes).toString("base64"),
          contentType: image.contentType,
          maxBytes,
          canvasId: request.key.canvasId
        });
      } catch {
        return failed(request, "write-failed");
      }
      if (
        imported.contentType !== image.contentType ||
        imported.size !== image.bytes.length ||
        !/^[0-9a-f]{64}$/.test(imported.checksum) ||
        imported.storageKey.trim().length === 0
      ) {
        return failed(request, "verification-failed");
      }
      try {
        const verified = await media.verify(
          imported.storageKey,
          { contentType: image.contentType, size: image.bytes.length, checksum: imported.checksum },
          { canvasId: request.key.canvasId }
        );
        if (!verified.exists || !verified.matches) return failed(request, "verification-failed");
      } catch {
        return failed(request, "verification-failed");
      }

      const metadata: WorldCaptureMediaMetadata = {
        version: "world-capture-media-v2",
        mediaId: imported.storageKey,
        storageKey: imported.storageKey,
        checksum: imported.checksum,
        contentType: image.contentType,
        size: image.bytes.length,
        width: dimensions.width,
        height: dimensions.height
      };
      return {
        status: "saved",
        receipt: {
          requestId: request.requestId,
          key: request.key,
          contentFingerprint: request.contentFingerprint,
          media: metadata
        }
      };
    }
  };
}

function failed(
  request: WorldCaptureMediaSaveRequest,
  code: "write-failed" | "verification-failed"
): WorldCaptureMediaSaveResult {
  return {
    status: "failed",
    requestId: request.requestId,
    key: request.key,
    contentFingerprint: request.contentFingerprint,
    code
  };
}

/**
 * 动态镜头视频保存端口：先读真实 MP4（mdhd 时长 + tkhd 像素），再登记 `world-capture-video-media-v1`。
 * 容器/时长/尺寸不匹配或上传校验失败都不会产生 ready 资产。
 */
export function createVideoCaptureMediaSavePort(
  media: BackendMediaPort,
  options: { maxBytes?: number } = {}
): WorldCaptureVideoMediaSavePort {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
  return {
    async save(request: WorldCaptureDynamicMediaSaveRequest): Promise<WorldCaptureDynamicSaveResult> {
      const { video } = request;
      if (video.bytes.length === 0 || video.bytes.length > maxBytes || video.contentType !== "video/mp4") {
        return videoFailed(request, "verification-failed");
      }
      const info = readWorldCaptureVideoInfo(video.bytes);
      if (
        !info ||
        info.width !== video.width ||
        info.height !== video.height ||
        Math.abs(info.durationSeconds - video.durationSeconds) > 0.5
      ) {
        return videoFailed(request, "verification-failed");
      }

      let imported: { storageKey: string; contentType: string; size: number; checksum: string };
      try {
        imported = await media.importBytes({
          bytesBase64: Buffer.from(video.bytes).toString("base64"),
          contentType: video.contentType,
          maxBytes,
          canvasId: request.key.canvasId
        });
      } catch {
        return videoFailed(request, "write-failed");
      }
      if (
        imported.contentType !== video.contentType ||
        imported.size !== video.bytes.length ||
        !/^[0-9a-f]{64}$/.test(imported.checksum) ||
        imported.storageKey.trim().length === 0
      ) {
        return videoFailed(request, "verification-failed");
      }
      try {
        const verified = await media.verify(
          imported.storageKey,
          { contentType: video.contentType, size: video.bytes.length, checksum: imported.checksum },
          { canvasId: request.key.canvasId }
        );
        if (!verified.exists || !verified.matches) return videoFailed(request, "verification-failed");
      } catch {
        return videoFailed(request, "verification-failed");
      }

      return {
        status: "saved",
        requestId: request.requestId,
        key: request.key,
        contentFingerprint: request.contentFingerprint,
        media: {
          version: WORLD_CAPTURE_VIDEO_MEDIA_VERSION,
          mediaId: imported.storageKey,
          storageKey: imported.storageKey,
          checksum: imported.checksum,
          size: video.bytes.length,
          contentType: video.contentType,
          width: info.width,
          height: info.height,
          container: "video/mp4",
          durationSeconds: info.durationSeconds,
          fps: video.fps
        }
      };
    }
  };
}

function videoFailed(
  request: WorldCaptureDynamicMediaSaveRequest,
  code: "write-failed" | "verification-failed"
): WorldCaptureDynamicSaveResult {
  return {
    status: "failed",
    requestId: request.requestId,
    key: request.key,
    contentFingerprint: request.contentFingerprint,
    code
  };
}
