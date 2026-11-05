/**
 * Trusted static-capture media save adapter (T10).
 *
 * The capture pipeline hands over temporary rendered bytes. This adapter is the only
 * place that persists them:
 *
 * 1. inspect the actual encoded image header for exact pixel dimensions;
 * 2. import the bytes through Media Service (content-addressed storage);
 * 3. verify the returned metadata against the bytes and header (checksum, byte size,
 *    content type);
 * 4. emit the v2 `WorldCaptureMediaMetadata`, which is the only value the pipeline may
 *    freeze into a generation input.
 *
 * It never reads bytes back from storage and never trusts a producer-provided key,
 * checksum or dimension.
 */
import {
  isInspectableWorldCaptureContentType,
  readWorldCaptureImageDimensions,
  type WorldCaptureMediaMetadata,
  type WorldCaptureMediaSavePort,
  type WorldCaptureMediaSaveRequest,
  type WorldCaptureMediaSaveResult
} from "@woohaa3/contracts";

/** Narrow media imports needed by the save port; satisfied by `BackendMediaPort`. */
export type WorldCaptureMediaImportPort = {
  importBytes(input: {
    bytesBase64: string;
    contentType: string;
    maxBytes?: number;
    canvasId?: string;
  }): Promise<{ storageKey: string; contentType: string; size: number; checksum: string }>;
  verify(
    storageKey: string,
    expected?: { contentType?: string; size?: number; checksum?: string },
    scope?: { canvasId: string }
  ): Promise<{ exists: boolean; matches: boolean }>;
};

export type WorldCaptureMediaSaveOptions = {
  media: WorldCaptureMediaImportPort;
  /** Hard cap for a static capture before it can reach Media Service. */
  maxBytes?: number;
};

const DEFAULT_MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

export function createWorldCaptureMediaSavePort(
  options: WorldCaptureMediaSaveOptions
): WorldCaptureMediaSavePort {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
  return {
    async save(request: WorldCaptureMediaSaveRequest): Promise<WorldCaptureMediaSaveResult> {
      const { image } = request;
      if (image.bytes.length === 0 || image.bytes.length > maxBytes) {
        return failed(request, "verification-failed");
      }
      if (!isInspectableWorldCaptureContentType(image.contentType)) {
        return failed(request, "verification-failed");
      }
      const dimensions = readWorldCaptureImageDimensions(image.bytes, image.contentType);
      if (
        !dimensions ||
        dimensions.width !== image.width ||
        dimensions.height !== image.height
      ) {
        return failed(request, "verification-failed");
      }

      let imported: { storageKey: string; contentType: string; size: number; checksum: string };
      try {
        imported = await options.media.importBytes({
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
        const verified = await options.media.verify(
          imported.storageKey,
          { contentType: image.contentType, size: image.bytes.length, checksum: imported.checksum },
          { canvasId: request.key.canvasId }
        );
        if (!verified.exists || !verified.matches) return failed(request, "verification-failed");
      } catch {
        return failed(request, "verification-failed");
      }

      const media: WorldCaptureMediaMetadata = {
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
          media
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
