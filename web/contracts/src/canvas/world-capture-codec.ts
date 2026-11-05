/**
 * Stable capture version-key and frozen-input metadata codecs (OC06).
 *
 * This module is deliberately pure: it performs no media request, storage access,
 * timer, subscription or scheduling. It builds on the frozen T10 contract in
 * `world-capture-contract.ts` instead of inventing a second capture protocol.
 *
 * The version key is encoded as the canonical text produced by
 * `worldCaptureVersionSignature`: a JSON array with a fixed field order. JSON
 * escaping keeps ids containing separators from colliding with a different field
 * split. Decoding accepts only that canonical text, so two different spellings of
 * the same key cannot become two different capture identities.
 *
 * Every opaque version is compared only for exact equality. Neither this module nor
 * its text encoding defines ordering, numeric parsing or version sorting. A caller
 * that receives results out of order must compare complete keys and decide what to
 * do; this codec never schedules or rewrites results.
 *
 * Frozen input metadata is the T10 `WorldCaptureFrozenInput` shape. Decoding
 * requires the exact input/media allowlists, stable media identity, lowercase
 * SHA-256 checksum, positive safe integer byte size, exact positive safe integer
 * pixel width/height and a static image content type. Runtime fields
 * (request/worker/capture status, URLs, timestamps and so on) are rejected as
 * unknown keys. Successful encode/decode calls return fresh copies.
 */

import {
  codecFailureError,
  decodeFailure
} from "./shared-world-codec.js";
import type { SharedWorldDecodeResult, WorldCaptureVersionKey } from "./shared-world.js";
import {
  decodeWorldCaptureFrozenInput,
  decodeWorldCaptureVersionKey,
  worldCaptureVersionSignature,
  type WorldCaptureFrozenInput
} from "./world-capture-contract.js";

const KEY_FIELD_COUNT = 6;

/** Exact comparison result; there is intentionally no ordering variant. */
export type WorldCaptureVersionComparison = "equal" | "different";

/**
 * Canonical text form of a six-field capture version key. The output is stable for
 * equal keys and is exactly the T10 signature, so key identity has one spelling.
 */
export function encodeWorldCaptureVersionKeyText(value: WorldCaptureVersionKey): string {
  return worldCaptureVersionSignature(value);
}

/**
 * Decode only canonical key text. Whitespace, reordered fields, extra entries and
 * non-string values are rejected instead of being normalized into another identity.
 */
export function decodeWorldCaptureVersionKeyText(
  input: unknown
): SharedWorldDecodeResult<WorldCaptureVersionKey> {
  if (typeof input !== "string" || input.length === 0) {
    return decodeFailure("invalid-data", input);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return decodeFailure("invalid-data", input);
  }
  if (!Array.isArray(parsed) || parsed.length !== KEY_FIELD_COUNT) {
    return decodeFailure("invalid-data", input);
  }

  const [
    canvasId,
    cameraId,
    worldContentVersion,
    cameraSettingsVersion,
    bindingVersion,
    outputVersion
  ] = parsed;
  const decoded = decodeWorldCaptureVersionKey({
    canvasId,
    cameraId,
    worldContentVersion,
    cameraSettingsVersion,
    bindingVersion,
    outputVersion
  });
  if (!decoded.ok) return decodeFailure(decoded.code, input);
  if (worldCaptureVersionSignature(decoded.value) !== input) {
    return decodeFailure("invalid-data", input);
  }
  return decoded;
}

/**
 * Compare complete keys by exact equality. Invalid keys are never equal, including
 * an invalid key compared with itself. Opaque versions are never ordered.
 */
export function compareWorldCaptureVersionKeys(
  left: WorldCaptureVersionKey,
  right: WorldCaptureVersionKey
): WorldCaptureVersionComparison {
  const decodedLeft = decodeWorldCaptureVersionKey(left);
  const decodedRight = decodeWorldCaptureVersionKey(right);
  if (!decodedLeft.ok || !decodedRight.ok) return "different";
  return encodeWorldCaptureVersionKeyText(decodedLeft.value) ===
    encodeWorldCaptureVersionKeyText(decodedRight.value)
    ? "equal"
    : "different";
}

/**
 * Decode frozen input metadata with the T10 exact allowlists. Missing or unknown
 * fields reject the whole envelope; a fresh key/media copy is returned on success.
 */
export function decodeWorldCaptureInputMetadata(
  input: unknown
): SharedWorldDecodeResult<WorldCaptureFrozenInput> {
  return decodeWorldCaptureFrozenInput(input);
}

/** Re-validate and canonicalize frozen input metadata; throws on invalid data. */
export function encodeWorldCaptureInputMetadata(value: WorldCaptureFrozenInput): unknown {
  const decoded = decodeWorldCaptureInputMetadata(value);
  if (!decoded.ok) throw codecFailureError(decoded.code, "世界捕获输入元数据");
  return decoded.value;
}

/**
 * Exact equality of the complete frozen input, including the capture key, media
 * identity, every static media field and the independent pixel width/height.
 * Invalid metadata is never equal.
 */
export function worldCaptureInputMetadataEqual(
  left: WorldCaptureFrozenInput,
  right: WorldCaptureFrozenInput
): boolean {
  const decodedLeft = decodeWorldCaptureInputMetadata(left);
  const decodedRight = decodeWorldCaptureInputMetadata(right);
  if (!decodedLeft.ok || !decodedRight.ok) return false;
  if (compareWorldCaptureVersionKeys(decodedLeft.value.key, decodedRight.value.key) !== "equal") {
    return false;
  }
  const leftMedia = decodedLeft.value.media;
  const rightMedia = decodedRight.value.media;
  return decodedLeft.value.version === decodedRight.value.version &&
    leftMedia.version === rightMedia.version &&
    leftMedia.mediaId === rightMedia.mediaId &&
    leftMedia.storageKey === rightMedia.storageKey &&
    leftMedia.checksum === rightMedia.checksum &&
    leftMedia.contentType === rightMedia.contentType &&
    leftMedia.size === rightMedia.size &&
    leftMedia.width === rightMedia.width &&
    leftMedia.height === rightMedia.height;
}
