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
  WorldCaptureMediaMetadata,
  WorldCaptureMediaSavePort,
  WorldCaptureMediaSaveRequest,
  WorldCaptureMediaSaveResult
} from "@woohaa3/contracts";
import {
  isInspectableWorldCaptureContentType,
  readWorldCaptureImageDimensions
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
