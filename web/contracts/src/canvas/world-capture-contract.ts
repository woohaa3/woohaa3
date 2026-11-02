/**
 * Shared-world capture version and frozen-input contract (T10).
 *
 * This module freezes the pure contract used between a world-camera capture and
 * downstream generation. It deliberately contains no async scheduler, no OC06
 * capture orchestration and no media I/O: callers decide when to refresh, when to
 * replace a pending request and when to cancel it, then use these helpers to reject
 * stale results and freeze exactly the media that belongs to the accepted version.
 *
 * Version rules come from T01 (`WorldCaptureVersionKey` / `WorldCaptureInput`):
 *
 * - `worldContentVersion` is the canonical authoring content version. Every
 *   canonical authoring change advances it; viewport, hover, occupancy heartbeats
 *   and capture-cache publication are intentionally absent from the key so they
 *   cannot retrigger capture forever.
 * - `cameraSettingsVersion`, `bindingVersion` and `outputVersion` identify the
 *   camera settings, the camera binding and the output configuration. They are
 *   opaque: this contract compares them only for exact equality. It never derives
 *   ordering (for example with `<`, numeric parsing or version sort) from them.
 * - A capture result is valid only when its complete key equals the current key.
 *   A late result for an older key is rejected; it can never overwrite the current
 *   framing.
 *
 * Static media metadata freezes a stable media reference (`storageKey`), its
 * SHA-256 checksum, content type and byte size. The `WorldCaptureInput` produced
 * by `toWorldCaptureInput` remains exactly the T01 shape, so downstream tasks do
 * not need a second media contract.
 *
 * Dynamic capture is reserved for T12. It must add its own versioned animation /
 * time-range fields and a new contract version; this module defines no dynamic
 * timing shape or codec so it cannot accidentally guess that protocol.
 */

import { isValidStorageKey } from "../validation.js";
import {
  type SharedWorldDecodeResult,
  type WorldCaptureInput,
  type WorldCaptureVersionKey,
  type WorldId,
  type WorldVersion
} from "./shared-world.js";
import {
  codecFailureError,
  decodeFailure,
  hasOnlyKeys,
  isJsonRecord,
  isNonEmptyWorldId,
  ownField
} from "./shared-world-codec.js";

/** Version of the frozen capture-input envelope, not the media format. */
export const WORLD_CAPTURE_INPUT_VERSION = "world-capture-input-v1" as const;
/** Version of the static media metadata envelope. */
export const WORLD_CAPTURE_MEDIA_VERSION = "world-capture-media-v1" as const;

const KEY_KEYS = [
  "canvasId",
  "cameraId",
  "worldContentVersion",
  "cameraSettingsVersion",
  "bindingVersion",
  "outputVersion"
] as const;
const MEDIA_KEYS = ["version", "mediaId", "storageKey", "checksum", "contentType", "size"] as const;
const FROZEN_INPUT_KEYS = ["version", "key", "media"] as const;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;
/** Static captures are images; this is a media-type guard, not an output codec. */
const CONTENT_TYPE_PATTERN = /^image\/[a-z0-9][a-z0-9.+-]{0,127}$/;

/** Decode an exact six-field capture version key. No field is inferred or defaulted. */
export function decodeWorldCaptureVersionKey(
  input: unknown
): SharedWorldDecodeResult<WorldCaptureVersionKey> {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, KEY_KEYS)) {
    return decodeFailure("invalid-data", input);
  }
  const canvasId = ownField(input, "canvasId");
  const cameraId = ownField(input, "cameraId");
  const worldContentVersion = ownField(input, "worldContentVersion");
  const cameraSettingsVersion = ownField(input, "cameraSettingsVersion");
  const bindingVersion = ownField(input, "bindingVersion");
  const outputVersion = ownField(input, "outputVersion");
  if (
    !isNonEmptyWorldId(canvasId) ||
    !isNonEmptyWorldId(cameraId) ||
    !isNonEmptyWorldId(worldContentVersion) ||
    !isNonEmptyWorldId(cameraSettingsVersion) ||
    !isNonEmptyWorldId(bindingVersion) ||
    !isNonEmptyWorldId(outputVersion)
  ) {
    return decodeFailure("invalid-data", input);
  }
  return {
    ok: true,
    value: {
      canvasId,
      cameraId,
      worldContentVersion,
      cameraSettingsVersion,
      bindingVersion,
      outputVersion
    }
  };
}

/** Re-validate and canonicalize a version key; throws instead of emitting invalid data. */
export function encodeWorldCaptureVersionKey(value: WorldCaptureVersionKey): unknown {
  const decoded = decodeWorldCaptureVersionKey(value);
  if (!decoded.ok) throw codecFailureError(decoded.code, "世界捕获版本键");
  return decoded.value;
}

/**
 * Stable, collision-free key encoding. JSON array order is fixed and ids are
 * escaped, so ids containing separators cannot collide with a different field
 * split. The encoding is an identity only: opaque versions are not sortable.
 */
export function worldCaptureVersionSignature(key: WorldCaptureVersionKey): string {
  const decoded = decodeWorldCaptureVersionKey(key);
  if (!decoded.ok) throw codecFailureError(decoded.code, "世界捕获版本键");
  const value = decoded.value;
  return JSON.stringify([
    value.canvasId,
    value.cameraId,
    value.worldContentVersion,
    value.cameraSettingsVersion,
    value.bindingVersion,
    value.outputVersion
  ]);
}

/** Exact equality of all six key fields; invalid values are never equal. */
export function worldCaptureVersionKeysEqual(
  left: WorldCaptureVersionKey,
  right: WorldCaptureVersionKey
): boolean {
  const decodedLeft = decodeWorldCaptureVersionKey(left);
  const decodedRight = decodeWorldCaptureVersionKey(right);
  if (!decodedLeft.ok || !decodedRight.ok) return false;
  return worldCaptureVersionSignature(decodedLeft.value) === worldCaptureVersionSignature(decodedRight.value);
}

/** Changes that cannot advance the canonical authoring version or retrigger capture. */
export const WORLD_CAPTURE_NON_AUTHORING_CAUSES = [
  "viewport",
  "hover",
  "occupancy-heartbeat",
  "capture-cache-publish"
] as const;

export type WorldCaptureNonAuthoringCause = (typeof WORLD_CAPTURE_NON_AUTHORING_CAUSES)[number];

/**
 * An authoring change carries the new opaque version supplied by its authority.
 * The contract does not mint or order versions; it only records which field moved.
 */
export type WorldCaptureAuthoringChange =
  | { kind: "world-content"; worldContentVersion: WorldVersion }
  | { kind: "camera-settings"; cameraSettingsVersion: WorldVersion }
  | { kind: "camera-binding"; bindingVersion: WorldVersion }
  | { kind: "output"; outputVersion: WorldVersion };

export type WorldCaptureChange =
  | WorldCaptureAuthoringChange
  | { kind: "non-authoring"; cause: WorldCaptureNonAuthoringCause };

/**
 * Apply one observed change to a key. Non-authoring changes return an equivalent
 * key, so repeated viewport/hover/heartbeat/cache events cannot produce a new
 * capture identity. Authoring changes replace exactly one opaque version field.
 *
 * Passing the same opaque version back is a no-op: the contract does not treat it
 * as a new version just because a write occurred.
 */
export function applyWorldCaptureChange(
  current: WorldCaptureVersionKey,
  change: WorldCaptureChange
): WorldCaptureVersionKey {
  const decoded = decodeWorldCaptureVersionKey(current);
  if (!decoded.ok) throw codecFailureError(decoded.code, "世界捕获版本键");
  const key = decoded.value;
  if (change.kind === "non-authoring") return key;

  const nextVersion = readAuthoringVersion(change);
  if (!isNonEmptyWorldId(nextVersion)) {
    throw codecFailureError("invalid-data", "世界捕获创作版本");
  }
  switch (change.kind) {
    case "world-content":
      return { ...key, worldContentVersion: nextVersion };
    case "camera-settings":
      return { ...key, cameraSettingsVersion: nextVersion };
    case "camera-binding":
      return { ...key, bindingVersion: nextVersion };
    case "output":
      return { ...key, outputVersion: nextVersion };
  }
}

/** Whether this change moved the capture identity away from `current`. */
export function worldCaptureChangeInvalidates(
  current: WorldCaptureVersionKey,
  change: WorldCaptureChange
): boolean {
  return !worldCaptureVersionKeysEqual(current, applyWorldCaptureChange(current, change));
}

/** Static media metadata for one captured framing. Bytes live in Media Service. */
export interface WorldCaptureMediaMetadata {
  version: typeof WORLD_CAPTURE_MEDIA_VERSION;
  mediaId: WorldId;
  /** Content-addressed stable reference; never a URL, data URI or blob URL. */
  storageKey: string;
  /** Lowercase SHA-256 hex of the stored bytes. */
  checksum: string;
  contentType: string;
  /** Byte size: a finite, positive safe integer. */
  size: number;
}

/** Decode static media metadata with an exact v1 allowlist. */
export function decodeWorldCaptureMediaMetadata(
  input: unknown
): SharedWorldDecodeResult<WorldCaptureMediaMetadata> {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, MEDIA_KEYS)) {
    return decodeFailure("invalid-data", input);
  }
  const version = ownField(input, "version");
  if (typeof version !== "string" || version.length === 0) return decodeFailure("invalid-data", input);
  if (version !== WORLD_CAPTURE_MEDIA_VERSION) return decodeFailure("unsupported-version", input);

  const mediaId = ownField(input, "mediaId");
  const storageKey = ownField(input, "storageKey");
  const checksum = ownField(input, "checksum");
  const contentType = ownField(input, "contentType");
  const size = ownField(input, "size");
  if (!isNonEmptyWorldId(mediaId) || !isValidStorageKey(storageKey)) {
    return decodeFailure("invalid-data", input);
  }
  if (typeof checksum !== "string" || !CHECKSUM_PATTERN.test(checksum)) {
    return decodeFailure("invalid-data", input);
  }
  if (typeof contentType !== "string" || !CONTENT_TYPE_PATTERN.test(contentType)) {
    return decodeFailure("invalid-data", input);
  }
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
    return decodeFailure("invalid-data", input);
  }
  return {
    ok: true,
    value: { version: WORLD_CAPTURE_MEDIA_VERSION, mediaId, storageKey, checksum, contentType, size }
  };
}

/** Re-validate and canonicalize media metadata; throws on invalid data. */
export function encodeWorldCaptureMediaMetadata(value: WorldCaptureMediaMetadata): unknown {
  const decoded = decodeWorldCaptureMediaMetadata(value);
  if (!decoded.ok) throw codecFailureError(decoded.code, "世界捕获媒体元数据");
  return decoded.value;
}

/**
 * Frozen capture input accepted by downstream generation. `key` is the exact
 * version examined at submission time, so later canvas edits cannot rewrite it.
 */
export interface WorldCaptureFrozenInput {
  version: typeof WORLD_CAPTURE_INPUT_VERSION;
  key: WorldCaptureVersionKey;
  media: WorldCaptureMediaMetadata;
}

/** Decode the frozen envelope, validating the key and static media together. */
export function decodeWorldCaptureFrozenInput(
  input: unknown
): SharedWorldDecodeResult<WorldCaptureFrozenInput> {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, FROZEN_INPUT_KEYS)) {
    return decodeFailure("invalid-data", input);
  }
  const version = ownField(input, "version");
  if (typeof version !== "string" || version.length === 0) return decodeFailure("invalid-data", input);
  if (version !== WORLD_CAPTURE_INPUT_VERSION) return decodeFailure("unsupported-version", input);

  const key = decodeWorldCaptureVersionKey(ownField(input, "key"));
  if (!key.ok) return decodeFailure(key.code, input);
  const media = decodeWorldCaptureMediaMetadata(ownField(input, "media"));
  if (!media.ok) return decodeFailure(media.code, input);

  return {
    ok: true,
    value: { version: WORLD_CAPTURE_INPUT_VERSION, key: key.value, media: media.value }
  };
}

/** Re-validate and canonicalize the frozen envelope; throws on invalid data. */
export function encodeWorldCaptureFrozenInput(value: WorldCaptureFrozenInput): unknown {
  const decoded = decodeWorldCaptureFrozenInput(value);
  if (!decoded.ok) throw codecFailureError(decoded.code, "世界捕获输入");
  return decoded.value;
}

/** Project the frozen envelope onto the T01 `WorldCaptureInput` media identity. */
export function toWorldCaptureInput(input: WorldCaptureFrozenInput): WorldCaptureInput {
  const decoded = decodeWorldCaptureFrozenInput(input);
  if (!decoded.ok) throw codecFailureError(decoded.code, "世界捕获输入");
  return {
    key: decoded.value.key,
    mediaId: decoded.value.media.mediaId,
    checksum: decoded.value.media.checksum
  };
}

/** A waiting consumer pinned to one key. `requestId` is only a request identity. */
export interface WorldCaptureWaitRequest {
  requestId: WorldId;
  key: WorldCaptureVersionKey;
}

/**
 * Explicit resolution of a wait. `cancelled` wins over version drift so a caller
 * can always report cancellation instead of silently consuming another framing.
 * A replaced version returns `superseded`; it never silently retargets the wait.
 */
export type WorldCaptureWaitResolution =
  | { status: "current"; requestId: WorldId; key: WorldCaptureVersionKey }
  | { status: "superseded"; requestId: WorldId; requestedKey: WorldCaptureVersionKey; currentKey: WorldCaptureVersionKey }
  | { status: "cancelled"; requestId: WorldId; key: WorldCaptureVersionKey };

/** Resolve a wait against the current key. Pure: no timer, promise or subscription. */
export function resolveWorldCaptureWait(
  request: WorldCaptureWaitRequest,
  currentKey: WorldCaptureVersionKey,
  cancelled: boolean
): WorldCaptureWaitResolution {
  const requestKey = decodeWorldCaptureVersionKey(request.key);
  if (!requestKey.ok) throw codecFailureError(requestKey.code, "世界捕获等待版本");
  const current = decodeWorldCaptureVersionKey(currentKey);
  if (!current.ok) throw codecFailureError(current.code, "世界捕获当前版本");
  if (!isNonEmptyWorldId(request.requestId)) {
    throw codecFailureError("invalid-data", "世界捕获等待身份");
  }

  if (cancelled) {
    return { status: "cancelled", requestId: request.requestId, key: requestKey.value };
  }
  if (!worldCaptureVersionKeysEqual(requestKey.value, current.value)) {
    return {
      status: "superseded",
      requestId: request.requestId,
      requestedKey: requestKey.value,
      currentKey: current.value
    };
  }
  return { status: "current", requestId: request.requestId, key: requestKey.value };
}

export type WorldCaptureFreezeFailureCode = "capture-stale" | "invalid-data";

export type WorldCaptureFreezeResult =
  | { ok: true; input: WorldCaptureFrozenInput }
  | { ok: false; code: WorldCaptureFreezeFailureCode; currentKey?: WorldCaptureVersionKey };

/**
 * Freeze the requested key together with exactly the supplied media metadata.
 * The request is accepted only while the requested key is still current; an old
 * result returns `capture-stale` and never borrows the newer framing's media.
 */
export function freezeWorldCaptureInput(
  requestedKey: WorldCaptureVersionKey,
  currentKey: WorldCaptureVersionKey,
  media: WorldCaptureMediaMetadata
): WorldCaptureFreezeResult {
  const requested = decodeWorldCaptureVersionKey(requestedKey);
  if (!requested.ok) return { ok: false, code: "invalid-data" };
  const current = decodeWorldCaptureVersionKey(currentKey);
  if (!current.ok) throw codecFailureError(current.code, "世界捕获当前版本");
  if (!worldCaptureVersionKeysEqual(requested.value, current.value)) {
    return { ok: false, code: "capture-stale", currentKey: current.value };
  }
  const decodedMedia = decodeWorldCaptureMediaMetadata(media);
  if (!decodedMedia.ok) return { ok: false, code: "invalid-data" };
  return {
    ok: true,
    input: { version: WORLD_CAPTURE_INPUT_VERSION, key: requested.value, media: decodedMedia.value }
  };
}

/** Result reported asynchronously by a capture worker. */
export type WorldCaptureSettlement =
  | { status: "ready"; key: WorldCaptureVersionKey; media: WorldCaptureMediaMetadata }
  | { status: "failed"; key: WorldCaptureVersionKey }
  | { status: "cancelled"; key: WorldCaptureVersionKey };

export type WorldCaptureSettlementDecision =
  | { decision: "apply"; input: WorldCaptureFrozenInput }
  | {
      decision: "reject";
      code: "capture-stale" | "cancelled" | "not-ready" | "invalid-data";
      currentKey?: WorldCaptureVersionKey;
    };

/**
 * Decide whether an async settlement may update current framing. Cancellation is
 * always explicit. Any non-cancelled result for an old key is rejected as stale,
 * including failures, so an old failure cannot mark the new framing as failed.
 * A current failure yields `not-ready`; the caller keeps its previous image marked
 * stale and must not present it as the latest valid input.
 */
export function settleWorldCaptureResult(
  settlement: WorldCaptureSettlement,
  currentKey: WorldCaptureVersionKey
): WorldCaptureSettlementDecision {
  const current = decodeWorldCaptureVersionKey(currentKey);
  if (!current.ok) throw codecFailureError(current.code, "世界捕获当前版本");
  if (settlement.status === "cancelled") {
    return { decision: "reject", code: "cancelled" };
  }

  const requested = decodeWorldCaptureVersionKey(settlement.key);
  if (!requested.ok) return { decision: "reject", code: "invalid-data" };
  if (!worldCaptureVersionKeysEqual(requested.value, current.value)) {
    return { decision: "reject", code: "capture-stale", currentKey: current.value };
  }
  if (settlement.status === "failed") {
    return { decision: "reject", code: "not-ready", currentKey: current.value };
  }

  const frozen = freezeWorldCaptureInput(requested.value, current.value, settlement.media);
  if (!frozen.ok) {
    return { decision: "reject", code: "invalid-data", currentKey: current.value };
  }
  return { decision: "apply", input: frozen.input };
}

function readAuthoringVersion(change: WorldCaptureAuthoringChange): WorldVersion {
  switch (change.kind) {
    case "world-content":
      return change.worldContentVersion;
    case "camera-settings":
      return change.cameraSettingsVersion;
    case "camera-binding":
      return change.bindingVersion;
    case "output":
      return change.outputVersion;
  }
}
