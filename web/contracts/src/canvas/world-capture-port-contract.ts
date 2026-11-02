/**
 * Static shared-world capture port shared by T09 (renderer producer) and T10
 * (refresh / generation pipeline).
 *
 * This module only freezes the pure boundary between the two consumers. It owns no
 * scheduler, queue, media storage, network request, renderer handle or occupancy
 * state. A caller decides when to request, cancel or replace a capture; these types
 * and helpers only prove that the produced image and saved media belong to exactly
 * the request that produced them.
 *
 * Ownership and trust boundaries:
 *
 * - T10 creates one `WorldCaptureRequest` from an immutable canonical snapshot. The
 *   request pins the complete `WorldCaptureVersionKey`, the snapshot world content
 *   and binding versions, the `WorldCameraData` settings snapshot, the exact output
 *   pixels and the immutable model content of every covered instance (see
 *   `world-capture-content-contract.ts`). T09 must consume that request instead of
 *   re-reading the mutable current scene.
 * - T09 resolves the pinned model content through the trusted
 *   `WorldCaptureContentResolutionPort` and rejects a resource whose content hash is
 *   not the pinned one. It then renders the request and reports a
 *   `WorldCaptureProducerOutcome` carrying the same `requestId`, key and content
 *   fingerprint. Its image bytes are temporary: they are not yet a valid generation
 *   input.
 * - An independent trusted media port saves those bytes. Only a verified
 *   `WorldCaptureMediaMetadata` v2 receipt (stable media id, storage key, SHA-256
 *   checksum, byte size and exact pixel width/height) can become a
 *   `WorldCaptureFrozenInput`.
 * - T10 validates producer identity, output dimensions/type, save association and
 *   current-key equality before freezing. A producer's self-reported key is never
 *   trusted on its own, and a cancelled or superseded result can never become the
 *   current valid media.
 *
 * Static scope rules:
 *
 * - An unbound camera captures the whole shared-world composition from the supplied
 *   snapshot. The request intentionally does not filter instances by scene area,
 *   scope or lease.
 * - A bound camera captures exactly one instance. A request whose bound target is
 *   missing is represented as `bound-missing`; an image returned for it is rejected
 *   and it never falls back to the whole world.
 * - Dynamic capture (time ranges, animation sampling, video containers) is owned by
 *   the later T12 contract. This module rejects dynamic capture modes and non-image
 *   output types so it cannot accidentally invent that protocol.
 *
 * Media metadata is deliberately strict: the existing v2 decoder rejects URLs,
 * data URIs, credentials, worker/session identifiers, mutable runtime arrays and any
 * field outside the exact allowlist. Pixel width/height are validated separately from
 * the byte `size`; this contract never treats one as the other.
 */

import {
  codecFailureError,
  decodeFailure,
  decodeWorldInstanceData,
  hasOnlyKeys,
  isJsonRecord,
  isNonEmptyWorldId,
  ownField
} from "./shared-world-codec.js";
import {
  type SharedWorldDecodeResult,
  type WorldCameraData,
  type WorldCaptureVersionKey,
  type WorldId,
  type WorldInstanceData,
  type WorldVersion
} from "./shared-world.js";
import { decodeWorldCamera } from "./world-camera-codec.js";
import {
  createWorldCaptureInstanceContents,
  createWorldCaptureModelContent,
  isWorldCaptureContentFingerprint,
  verifyWorldCaptureContentResolution,
  worldCaptureContentFingerprint,
  type WorldCaptureContentResolution,
  type WorldCaptureContentResolutionRequest,
  type WorldCaptureInstanceContent,
  type WorldCaptureModelContent
} from "./world-capture-content-contract.js";
import {
  decodeWorldCaptureMediaMetadata,
  decodeWorldCaptureVersionKey,
  freezeWorldCaptureInput,
  resolveWorldCaptureWait,
  worldCaptureVersionKeysEqual,
  type WorldCaptureFrozenInput,
  type WorldCaptureMediaMetadata
} from "./world-capture-contract.js";

const REQUEST_KEYS = [
  "requestId",
  "key",
  "worldContentVersion",
  "bindingVersion",
  "camera",
  "subject",
  "output",
  "contentFingerprint"
] as const;
const OUTPUT_KEYS = ["outputVersion", "width", "height", "contentType"] as const;
const WORLD_SUBJECT_KEYS = ["kind", "instances", "contents"] as const;
const INSTANCE_SUBJECT_KEYS = ["kind", "instanceId", "instance", "content"] as const;
const MISSING_SUBJECT_KEYS = ["kind", "instanceId"] as const;
const IMAGE_KEYS = ["bytes", "contentType", "width", "height"] as const;
const RECEIPT_KEYS = ["requestId", "key", "contentFingerprint", "media"] as const;
const SAVED_RESULT_KEYS = ["status", "receipt"] as const;
const SAVE_FAILURE_KEYS = ["status", "requestId", "key", "contentFingerprint", "code"] as const;
const CANCELLED_RESULT_KEYS = ["status", "requestId", "key", "contentFingerprint"] as const;

const WAITING_REASONS = ["resources-not-ready"] as const;
const UNAVAILABLE_REASONS = [
  "bound-target-missing",
  "renderer-unavailable",
  "content-unavailable",
  "content-replaced"
] as const;
const PRODUCER_FAILURE_CODES = [
  "render-failed",
  "readback-failed",
  "invalid-output",
  "content-mismatch"
] as const;
const MEDIA_SAVE_FAILURE_CODES = ["write-failed", "verification-failed"] as const;

/** Static captures are images. Video/dynamic output types are T12 work. */
const IMAGE_CONTENT_TYPE_PATTERN = /^image\/[a-z0-9][a-z0-9.+-]{0,127}$/;

export type WorldCaptureWaitingReason = (typeof WAITING_REASONS)[number];
export type WorldCaptureUnavailableReason = (typeof UNAVAILABLE_REASONS)[number];
export type WorldCaptureProducerFailureCode = (typeof PRODUCER_FAILURE_CODES)[number];
export type WorldCaptureMediaSaveFailureCode = (typeof MEDIA_SAVE_FAILURE_CODES)[number];

/** Exact output configuration. `outputVersion` must equal the request key field. */
export interface WorldCaptureOutputSpec {
  readonly outputVersion: WorldVersion;
  /** Exact pixel width; never derived from the byte size or camera aspect. */
  readonly width: number;
  /** Exact pixel height; never derived from the byte size or camera aspect. */
  readonly height: number;
  /** Static image media type, for example `image/png`. */
  readonly contentType: string;
}

/** Unbound framing: every instance in the immutable shared-world snapshot. */
export interface WorldCaptureWorldSubject {
  readonly kind: "world";
  readonly instances: readonly WorldInstanceData[];
  /** Exactly one pinned content value per instance; never a current-scene lookup. */
  readonly contents: readonly WorldCaptureInstanceContent[];
}

/** Bound framing: exactly one target instance and no other model. */
export interface WorldCaptureInstanceSubject {
  readonly kind: "instance";
  readonly instanceId: WorldId;
  readonly instance: WorldInstanceData;
  /** Immutable model content of the bound instance; no other model is included. */
  readonly content: WorldCaptureModelContent;
}

/** Bound target missing from the snapshot; no whole-world fallback is allowed. */
export interface WorldCaptureMissingBindingSubject {
  readonly kind: "bound-missing";
  readonly instanceId: WorldId;
}

export type WorldCaptureSubject =
  | WorldCaptureWorldSubject
  | WorldCaptureInstanceSubject
  | WorldCaptureMissingBindingSubject;

/**
 * Immutable request owned by T10 and consumed by T09. Every opaque version field is
 * tied to the matching `WorldCaptureVersionKey` field:
 *
 * - `worldContentVersion` -> `key.worldContentVersion`
 * - `bindingVersion` -> `key.bindingVersion`
 * - `camera.cameraId` -> `key.cameraId`
 * - `camera.settingsVersion` -> `key.cameraSettingsVersion`
 * - `output.outputVersion` -> `key.outputVersion`
 *
 * `contentFingerprint` is derived from the immutable model content carried by
 * `subject` during decode. It is not a free-form producer label: a mismatching value
 * rejects the request, and a producer outcome that echoes a different fingerprint is
 * rejected instead of being rendered/adopted.
 *
 * `key.canvasId` remains the request's canvas identity. A successful decode returns a
 * deeply frozen copy, so neither later caller mutation nor a second consumer can
 * change the input T09 is rendering.
 */
export interface WorldCaptureRequest {
  readonly requestId: WorldId;
  readonly key: WorldCaptureVersionKey;
  readonly worldContentVersion: WorldVersion;
  readonly bindingVersion: WorldVersion;
  /** Preview and final output use this same camera pose/projection/aspect snapshot. */
  readonly camera: WorldCameraData;
  readonly subject: WorldCaptureSubject;
  readonly output: WorldCaptureOutputSpec;
  /** Derived from `subject` content; distinguishes same-id/same-pose model versions. */
  readonly contentFingerprint: string;
}

/** Temporary rendered bytes plus the exact pixel size and media type T09 produced. */
export interface WorldCaptureImage {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
}

/**
 * T09 outcome for one request. `waiting` is transient resource readiness; `unavailable`
 * distinguishes a missing bound target from a renderer that cannot render. A replaced
 * request is decided by T10 with `resolveWorldCaptureOutcome`, not self-reported here.
 */
export type WorldCaptureProducerOutcome =
  | {
      readonly status: "image";
      readonly requestId: WorldId;
      readonly key: WorldCaptureVersionKey;
      readonly contentFingerprint: string;
      readonly image: WorldCaptureImage;
    }
  | {
      readonly status: "waiting";
      readonly requestId: WorldId;
      readonly key: WorldCaptureVersionKey;
      readonly contentFingerprint: string;
      readonly reason: WorldCaptureWaitingReason;
    }
  | {
      readonly status: "unavailable";
      readonly requestId: WorldId;
      readonly key: WorldCaptureVersionKey;
      readonly contentFingerprint: string;
      readonly reason: WorldCaptureUnavailableReason;
    }
  | {
      readonly status: "failed";
      readonly requestId: WorldId;
      readonly key: WorldCaptureVersionKey;
      readonly contentFingerprint: string;
      readonly code: WorldCaptureProducerFailureCode;
    }
  | {
      readonly status: "cancelled";
      readonly requestId: WorldId;
      readonly key: WorldCaptureVersionKey;
      readonly contentFingerprint: string;
    };

/** Input handed to the independent trusted media port. Bytes are transient. */
export interface WorldCaptureMediaSaveRequest {
  readonly requestId: WorldId;
  readonly key: WorldCaptureVersionKey;
  readonly contentFingerprint: string;
  readonly image: WorldCaptureImage;
}

/** Stable media receipt; all fields are frozen metadata, never temporary bytes. */
export interface WorldCaptureMediaSaveReceipt {
  readonly requestId: WorldId;
  readonly key: WorldCaptureVersionKey;
  readonly contentFingerprint: string;
  readonly media: WorldCaptureMediaMetadata;
}

export type WorldCaptureMediaSaveResult =
  | { readonly status: "saved"; readonly receipt: WorldCaptureMediaSaveReceipt }
  | {
      readonly status: "failed";
      readonly requestId: WorldId;
      readonly key: WorldCaptureVersionKey;
      readonly contentFingerprint: string;
      readonly code: WorldCaptureMediaSaveFailureCode;
    }
  | {
      readonly status: "cancelled";
      readonly requestId: WorldId;
      readonly key: WorldCaptureVersionKey;
      readonly contentFingerprint: string;
    };

/**
 * Trusted media save port. Implementations own storage, hashing and verification;
 * this module only defines the boundary and validates the returned metadata.
 */
export interface WorldCaptureMediaSavePort {
  save(request: WorldCaptureMediaSaveRequest): Promise<WorldCaptureMediaSaveResult>;
}

export type WorldCaptureMediaVerificationCode =
  | "invalid-image"
  | "request-mismatch"
  | "media-unverified";

export type WorldCaptureMediaVerification =
  | { readonly ok: true; readonly media: WorldCaptureMediaMetadata }
  | { readonly ok: false; readonly code: WorldCaptureMediaVerificationCode };

export type WorldCaptureResolutionFailureCode =
  | WorldCaptureProducerFailureCode
  | "media-save-failed"
  | "media-verification-failed";

export type WorldCaptureRejectionCode =
  | "request-mismatch"
  | "content-mismatch"
  | "invalid-data"
  | "invalid-image"
  | "media-unverified"
  | "bound-target-missing";

/**
 * Complete pipeline decision. Only `ready` may be frozen into a generation input.
 * `media-required` means T09 produced valid-looking temporary bytes but no trusted
 * save has been verified yet. `cancelled` wins over version replacement; `superseded`
 * means the requested key is no longer current and the result must be discarded.
 */
export type WorldCaptureResolution =
  | {
      readonly status: "ready";
      readonly requestId: WorldId;
      readonly key: WorldCaptureVersionKey;
      /** Exact model content version that produced this frozen media. */
      readonly contentFingerprint: string;
      readonly input: WorldCaptureFrozenInput;
    }
  | {
      readonly status: "media-required";
      readonly requestId: WorldId;
      readonly key: WorldCaptureVersionKey;
      readonly image: WorldCaptureImage;
    }
  | {
      readonly status: "waiting";
      readonly requestId: WorldId;
      readonly key: WorldCaptureVersionKey;
      readonly reason: WorldCaptureWaitingReason;
    }
  | {
      readonly status: "unavailable";
      readonly requestId: WorldId;
      readonly key: WorldCaptureVersionKey;
      readonly reason: WorldCaptureUnavailableReason;
    }
  | {
      readonly status: "failed";
      readonly requestId: WorldId;
      readonly key: WorldCaptureVersionKey;
      readonly code: WorldCaptureResolutionFailureCode;
    }
  | {
      readonly status: "cancelled";
      readonly requestId: WorldId;
      readonly key: WorldCaptureVersionKey;
    }
  | {
      readonly status: "superseded";
      readonly requestId: WorldId;
      readonly requestedKey: WorldCaptureVersionKey;
      readonly currentKey: WorldCaptureVersionKey;
    }
  | {
      readonly status: "rejected";
      readonly requestId: WorldId;
      readonly key: WorldCaptureVersionKey;
      readonly code: WorldCaptureRejectionCode;
    };

export interface WorldCaptureOutcomeInput {
  readonly request: WorldCaptureRequest;
  readonly currentKey: WorldCaptureVersionKey;
  readonly cancelled: boolean;
  readonly outcome: WorldCaptureProducerOutcome;
  /** Omit while the trusted media save is still pending. */
  readonly saved?: WorldCaptureMediaSaveResult;
}

/**
 * Validate and deep-freeze one request. The returned value is independent of the
 * caller's nested objects and arrays; failed input preserves the caller's data.
 */
export function createWorldCaptureRequest(input: unknown): SharedWorldDecodeResult<WorldCaptureRequest> {
  return decodeWorldCaptureRequest(input);
}

/**
 * Build the immutable content-resolution input for T09. Only the request's pinned
 * content and derived fingerprint cross the trusted port boundary; the mutable capture
 * key and current scene are deliberately absent.
 */
export function createWorldCaptureContentResolutionRequest(
  request: WorldCaptureRequest
): WorldCaptureContentResolutionRequest {
  const decoded = decodeWorldCaptureRequest(request);
  if (!decoded.ok) throw codecFailureError(decoded.code, "世界捕获请求");
  return deepFreeze({
    requestId: decoded.value.requestId,
    contentFingerprint: decoded.value.contentFingerprint,
    instances: subjectContents(decoded.value.subject)
  });
}

/**
 * Map a trusted content-resolution answer to the producer outcome T09 reports. `null`
 * means the pinned resources are ready and T09 may render them. Waiting/unavailable
 * answers preserve the explicit content reason; a resolution that does not match the
 * pin is a failure, never a fallback to current geometry.
 */
export function worldCaptureContentResolutionOutcome(
  request: WorldCaptureRequest,
  resolution: WorldCaptureContentResolution
): WorldCaptureProducerOutcome | null {
  const resolutionRequest = createWorldCaptureContentResolutionRequest(request);
  const verified = verifyWorldCaptureContentResolution(resolutionRequest, resolution);
  if (!verified.ok) {
    return {
      status: "failed",
      requestId: request.requestId,
      key: request.key,
      contentFingerprint: request.contentFingerprint,
      code: "content-mismatch"
    };
  }
  const value = verified.resolution;
  switch (value.status) {
    case "ready":
      return null;
    case "waiting":
      return {
        status: "waiting",
        requestId: request.requestId,
        key: request.key,
        contentFingerprint: request.contentFingerprint,
        reason: value.reason
      };
    case "unavailable":
      return {
        status: "unavailable",
        requestId: request.requestId,
        key: request.key,
        contentFingerprint: request.contentFingerprint,
        reason: value.reason
      };
    case "failed":
      return {
        status: "failed",
        requestId: request.requestId,
        key: request.key,
        contentFingerprint: request.contentFingerprint,
        code: value.code
      };
  }
}

function subjectContents(
  subject: WorldCaptureSubject
): readonly WorldCaptureInstanceContent[] {
  switch (subject.kind) {
    case "world":
      return subject.contents;
    case "instance":
      return [{ instanceId: subject.instanceId, content: subject.content }];
    case "bound-missing":
      return [];
  }
}

function decodeWorldCaptureRequest(input: unknown): SharedWorldDecodeResult<WorldCaptureRequest> {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, REQUEST_KEYS)) {
    return decodeFailure("invalid-data", input);
  }

  const requestId = ownField(input, "requestId");
  if (!isNonEmptyWorldId(requestId)) return decodeFailure("invalid-data", input);

  const key = decodeWorldCaptureVersionKey(ownField(input, "key"));
  if (!key.ok) return decodeFailure(key.code, input);
  const versionKey = key.value;

  const worldContentVersion = ownField(input, "worldContentVersion");
  const bindingVersion = ownField(input, "bindingVersion");
  if (!isNonEmptyWorldId(worldContentVersion) || !isNonEmptyWorldId(bindingVersion)) {
    return decodeFailure("invalid-data", input);
  }
  if (
    worldContentVersion !== versionKey.worldContentVersion ||
    bindingVersion !== versionKey.bindingVersion
  ) {
    return decodeFailure("invalid-data", input);
  }

  const camera = decodeWorldCamera(ownField(input, "camera"));
  if (!camera.ok) return decodeFailure(camera.code, input);
  if (camera.value.captureMode.kind !== "static") return decodeFailure("invalid-data", input);
  if (
    camera.value.cameraId !== versionKey.cameraId ||
    camera.value.settingsVersion !== versionKey.cameraSettingsVersion
  ) {
    return decodeFailure("invalid-data", input);
  }

  const output = decodeOutputSpec(ownField(input, "output"));
  if (!output.ok) return decodeFailure(output.code, input);
  if (output.value.outputVersion !== versionKey.outputVersion) {
    return decodeFailure("invalid-data", input);
  }

  const subject = decodeSubject(ownField(input, "subject"), camera.value);
  if (!subject.ok) return decodeFailure(subject.code, input);

  const contentFingerprint = ownField(input, "contentFingerprint");
  if (
    !isWorldCaptureContentFingerprint(contentFingerprint) ||
    contentFingerprint !== worldCaptureContentFingerprint(subjectContents(subject.value))
  ) {
    return decodeFailure("invalid-data", input);
  }

  return {
    ok: true,
    value: deepFreeze({
      requestId,
      key: versionKey,
      worldContentVersion,
      bindingVersion,
      camera: camera.value,
      subject: subject.value,
      output: output.value,
      contentFingerprint
    })
  };
}

/**
 * Build the media-save request from a validated request and its temporary image.
 * The image must be for the exact request output and is copied before crossing the
 * port. A missing bound target can never produce a savable image.
 */
export function createWorldCaptureMediaSaveRequest(
  request: WorldCaptureRequest,
  image: WorldCaptureImage
): SharedWorldDecodeResult<WorldCaptureMediaSaveRequest> {
  const decodedRequest = decodeWorldCaptureRequest(request);
  if (!decodedRequest.ok) return decodeFailure(decodedRequest.code, request);
  const decodedImage = decodeWorldCaptureImage(image);
  if (
    !decodedImage ||
    decodedRequest.value.subject.kind === "bound-missing" ||
    !imageMatchesRequest(decodedRequest.value, decodedImage)
  ) {
    return decodeFailure("invalid-data", image);
  }
  const key = decodeWorldCaptureVersionKey(decodedRequest.value.key);
  if (!key.ok) return decodeFailure(key.code, request);
  return {
    ok: true,
    value: {
      requestId: decodedRequest.value.requestId,
      key: key.value,
      contentFingerprint: decodedRequest.value.contentFingerprint,
      image: decodedImage
    }
  };
}

/**
 * Verify a trusted media receipt against the request and temporary image. The media
 * port owns storage and checksum computation; this pure check proves request/key
 * association, v2 metadata validity, exact pixel dimensions, content type and byte
 * count. It performs no hashing, I/O or storage lookup.
 */
export function verifyWorldCaptureMediaSaveReceipt(
  request: WorldCaptureRequest,
  image: WorldCaptureImage,
  receipt: WorldCaptureMediaSaveReceipt
): WorldCaptureMediaVerification {
  const decodedRequest = decodeWorldCaptureRequest(request);
  if (!decodedRequest.ok) throw codecFailureError(decodedRequest.code, "世界捕获请求");
  const decodedImage = decodeWorldCaptureImage(image);
  if (
    !decodedImage ||
    decodedRequest.value.subject.kind === "bound-missing" ||
    !imageMatchesRequest(decodedRequest.value, decodedImage)
  ) {
    return { ok: false, code: "invalid-image" };
  }
  if (!isJsonRecord(receipt) || !hasOnlyKeys(receipt, RECEIPT_KEYS)) {
    return { ok: false, code: "media-unverified" };
  }

  const requestId = ownField(receipt, "requestId");
  const key = decodeWorldCaptureVersionKey(ownField(receipt, "key"));
  const contentFingerprint = ownField(receipt, "contentFingerprint");
  if (
    !isNonEmptyWorldId(requestId) ||
    !key.ok ||
    !isWorldCaptureContentFingerprint(contentFingerprint)
  ) {
    return { ok: false, code: "media-unverified" };
  }
  if (
    requestId !== decodedRequest.value.requestId ||
    !worldCaptureVersionKeysEqual(key.value, decodedRequest.value.key)
  ) {
    return { ok: false, code: "request-mismatch" };
  }
  if (contentFingerprint !== decodedRequest.value.contentFingerprint) {
    return { ok: false, code: "request-mismatch" };
  }

  const media = decodeWorldCaptureMediaMetadata(ownField(receipt, "media"));
  if (!media.ok) return { ok: false, code: "media-unverified" };
  if (
    media.value.width !== decodedImage.width ||
    media.value.height !== decodedImage.height ||
    media.value.contentType !== decodedImage.contentType ||
    media.value.size !== decodedImage.bytes.length
  ) {
    return { ok: false, code: "media-unverified" };
  }
  return { ok: true, media: media.value };
}

/**
 * Resolve one producer outcome against the still-current key and an optional trusted
 * media save. This function never reads the mutable scene, never schedules work and
 * never upgrades temporary bytes into a frozen input without verified v2 metadata.
 *
 * Ordering is intentional: an explicit pipeline cancellation wins over version
 * replacement; a no-longer-current key wins over any producer outcome; only then are
 * the producer's request identity, image, media receipt and current key checked.
 */
export function resolveWorldCaptureOutcome(input: WorldCaptureOutcomeInput): WorldCaptureResolution {
  const decodedRequest = decodeWorldCaptureRequest(input.request);
  if (!decodedRequest.ok) throw codecFailureError(decodedRequest.code, "世界捕获请求");
  const request = decodedRequest.value;

  const current = decodeWorldCaptureVersionKey(input.currentKey);
  if (!current.ok) throw codecFailureError(current.code, "世界捕获当前版本");

  const wait = resolveWorldCaptureWait(
    { requestId: request.requestId, key: request.key },
    current.value,
    input.cancelled
  );
  if (wait.status === "cancelled") {
    return { status: "cancelled", requestId: request.requestId, key: request.key };
  }
  if (wait.status === "superseded") {
    return {
      status: "superseded",
      requestId: request.requestId,
      requestedKey: request.key,
      currentKey: current.value
    };
  }

  const outcome = decodeWorldCaptureProducerOutcome(input.outcome);
  if (!outcome) {
    return rejected(
      request,
      isImageOutcomeForRequest(input.outcome, request) ? "invalid-image" : "invalid-data"
    );
  }
  if (
    outcome.requestId !== request.requestId ||
    !worldCaptureVersionKeysEqual(outcome.key, request.key)
  ) {
    return rejected(request, "request-mismatch");
  }
  if (outcome.contentFingerprint !== request.contentFingerprint) {
    return rejected(request, "content-mismatch");
  }

  switch (outcome.status) {
    case "cancelled":
      return { status: "cancelled", requestId: request.requestId, key: request.key };
    case "waiting":
      if (request.subject.kind === "bound-missing") {
        return {
          status: "unavailable",
          requestId: request.requestId,
          key: request.key,
          reason: "bound-target-missing"
        };
      }
      return {
        status: "waiting",
        requestId: request.requestId,
        key: request.key,
        reason: outcome.reason
      };
    case "unavailable":
      if (request.subject.kind === "world" && outcome.reason === "bound-target-missing") {
        return rejected(request, "invalid-data");
      }
      return {
        status: "unavailable",
        requestId: request.requestId,
        key: request.key,
        reason: outcome.reason
      };
    case "failed":
      return {
        status: "failed",
        requestId: request.requestId,
        key: request.key,
        code: outcome.code
      };
    case "image": {
      if (request.subject.kind === "bound-missing") {
        return rejected(request, "bound-target-missing");
      }
      const image = decodeWorldCaptureImage(outcome.image);
      if (!image || !imageMatchesRequest(request, image)) {
        return rejected(request, "invalid-image");
      }
      if (!input.saved) {
        return {
          status: "media-required",
          requestId: request.requestId,
          key: request.key,
          image
        };
      }

      const saved = decodeWorldCaptureMediaSaveResult(input.saved);
      if (!saved || !saveBelongsTo(saved, request)) {
        return rejected(request, "media-unverified");
      }
      if (saved.status === "cancelled") {
        return { status: "cancelled", requestId: request.requestId, key: request.key };
      }
      if (saved.status === "failed") {
        return {
          status: "failed",
          requestId: request.requestId,
          key: request.key,
          code:
            saved.code === "verification-failed"
              ? "media-verification-failed"
              : "media-save-failed"
        };
      }

      const verified = verifyWorldCaptureMediaSaveReceipt(request, image, saved.receipt);
      if (!verified.ok) {
        return rejected(
          request,
          verified.code === "invalid-image" ? "invalid-image" : "media-unverified"
        );
      }

      const frozen = freezeWorldCaptureInput(request.key, current.value, verified.media);
      if (!frozen.ok) return rejected(request, "invalid-data");
      return {
        status: "ready",
        requestId: request.requestId,
        key: request.key,
        contentFingerprint: request.contentFingerprint,
        input: frozen.input
      };
    }
  }
}

function rejected(request: WorldCaptureRequest, code: WorldCaptureRejectionCode): WorldCaptureResolution {
  return { status: "rejected", requestId: request.requestId, key: request.key, code };
}

function decodeOutputSpec(input: unknown): SharedWorldDecodeResult<WorldCaptureOutputSpec> {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, OUTPUT_KEYS)) {
    return decodeFailure("invalid-data", input);
  }
  const outputVersion = ownField(input, "outputVersion");
  const width = ownField(input, "width");
  const height = ownField(input, "height");
  const contentType = ownField(input, "contentType");
  if (!isNonEmptyWorldId(outputVersion)) return decodeFailure("invalid-data", input);
  if (!isPositiveSafeInteger(width) || !isPositiveSafeInteger(height)) {
    return decodeFailure("invalid-data", input);
  }
  if (typeof contentType !== "string" || !IMAGE_CONTENT_TYPE_PATTERN.test(contentType)) {
    return decodeFailure("invalid-data", input);
  }
  return { ok: true, value: { outputVersion, width, height, contentType } };
}

function decodeSubject(
  input: unknown,
  camera: WorldCameraData
): SharedWorldDecodeResult<WorldCaptureSubject> {
  if (!isJsonRecord(input)) return decodeFailure("invalid-data", input);
  const kind = ownField(input, "kind");

  if (kind === "world") {
    // An unbound camera captures the whole snapshot; filtering by area/scope is not
    // part of this contract.
    if (camera.boundInstanceId !== null) return decodeFailure("invalid-data", input);
    if (!hasOnlyKeys(input, WORLD_SUBJECT_KEYS)) return decodeFailure("invalid-data", input);
    const rawInstances = ownField(input, "instances");
    if (!Array.isArray(rawInstances)) return decodeFailure("invalid-data", input);
    const instances: WorldInstanceData[] = [];
    const seen = new Set<string>();
    for (const raw of rawInstances) {
      const instance = decodeWorldInstanceData(raw);
      if (!instance.ok) return decodeFailure(instance.code, input);
      if (seen.has(instance.value.instanceId)) return decodeFailure("invalid-data", input);
      seen.add(instance.value.instanceId);
      instances.push(instance.value);
    }
    const contents = createWorldCaptureInstanceContents(ownField(input, "contents"));
    if (!contents.ok) return decodeFailure(contents.code, input);
    if (contents.value.length !== instances.length) return decodeFailure("invalid-data", input);
    const contentIds = new Set(contents.value.map(content => content.instanceId));
    if (contentIds.size !== instances.length || instances.some(instance => !contentIds.has(instance.instanceId))) {
      return decodeFailure("invalid-data", input);
    }
    return { ok: true, value: { kind: "world", instances, contents: contents.value } };
  }

  if (kind === "instance") {
    if (!hasOnlyKeys(input, INSTANCE_SUBJECT_KEYS)) return decodeFailure("invalid-data", input);
    const instanceId = ownField(input, "instanceId");
    if (!isNonEmptyWorldId(instanceId) || camera.boundInstanceId !== instanceId) {
      return decodeFailure("invalid-data", input);
    }
    const instance = decodeWorldInstanceData(ownField(input, "instance"));
    if (!instance.ok) return decodeFailure(instance.code, input);
    if (instance.value.instanceId !== instanceId) return decodeFailure("invalid-data", input);
    const content = createWorldCaptureModelContent(ownField(input, "content"));
    if (!content.ok) return decodeFailure(content.code, input);
    return {
      ok: true,
      value: { kind: "instance", instanceId, instance: instance.value, content: content.value }
    };
  }

  if (kind === "bound-missing") {
    if (!hasOnlyKeys(input, MISSING_SUBJECT_KEYS)) return decodeFailure("invalid-data", input);
    const instanceId = ownField(input, "instanceId");
    if (!isNonEmptyWorldId(instanceId) || camera.boundInstanceId !== instanceId) {
      return decodeFailure("invalid-data", input);
    }
    return { ok: true, value: { kind: "bound-missing", instanceId } };
  }

  return decodeFailure("invalid-data", input);
}

function decodeWorldCaptureImage(input: unknown): WorldCaptureImage | null {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, IMAGE_KEYS)) return null;
  const bytes = ownField(input, "bytes");
  const contentType = ownField(input, "contentType");
  const width = ownField(input, "width");
  const height = ownField(input, "height");
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return null;
  if (typeof contentType !== "string" || !IMAGE_CONTENT_TYPE_PATTERN.test(contentType)) return null;
  if (!isPositiveSafeInteger(width) || !isPositiveSafeInteger(height)) return null;
  return { bytes: new Uint8Array(bytes), contentType, width, height };
}

function decodeWorldCaptureProducerOutcome(
  input: unknown
): WorldCaptureProducerOutcome | null {
  if (!isJsonRecord(input)) return null;
  const status = ownField(input, "status");
  const identity = readOutcomeIdentity(input);
  if (!identity) return null;

  switch (status) {
    case "image": {
      if (!hasOnlyKeys(input, ["status", "requestId", "key", "contentFingerprint", "image"])) {
        return null;
      }
      const image = decodeWorldCaptureImage(ownField(input, "image"));
      if (!image) return null;
      return {
        status,
        requestId: identity.requestId,
        key: identity.key,
        contentFingerprint: identity.contentFingerprint,
        image
      };
    }
    case "waiting": {
      if (!hasOnlyKeys(input, ["status", "requestId", "key", "contentFingerprint", "reason"])) {
        return null;
      }
      const reason = ownField(input, "reason");
      if (!isOneOf(reason, WAITING_REASONS)) return null;
      return {
        status,
        requestId: identity.requestId,
        key: identity.key,
        contentFingerprint: identity.contentFingerprint,
        reason
      };
    }
    case "unavailable": {
      if (!hasOnlyKeys(input, ["status", "requestId", "key", "contentFingerprint", "reason"])) {
        return null;
      }
      const reason = ownField(input, "reason");
      if (!isOneOf(reason, UNAVAILABLE_REASONS)) return null;
      return {
        status,
        requestId: identity.requestId,
        key: identity.key,
        contentFingerprint: identity.contentFingerprint,
        reason
      };
    }
    case "failed": {
      if (!hasOnlyKeys(input, ["status", "requestId", "key", "contentFingerprint", "code"])) {
        return null;
      }
      const code = ownField(input, "code");
      if (!isOneOf(code, PRODUCER_FAILURE_CODES)) return null;
      return {
        status,
        requestId: identity.requestId,
        key: identity.key,
        contentFingerprint: identity.contentFingerprint,
        code
      };
    }
    case "cancelled":
      if (!hasOnlyKeys(input, ["status", "requestId", "key", "contentFingerprint"])) return null;
      return {
        status,
        requestId: identity.requestId,
        key: identity.key,
        contentFingerprint: identity.contentFingerprint
      };
    default:
      return null;
  }
}

function decodeWorldCaptureMediaSaveResult(
  input: unknown
): WorldCaptureMediaSaveResult | null {
  if (!isJsonRecord(input)) return null;
  const status = ownField(input, "status");

  if (status === "saved") {
    if (!hasOnlyKeys(input, SAVED_RESULT_KEYS)) return null;
    const receipt = decodeWorldCaptureMediaSaveReceipt(ownField(input, "receipt"));
    if (!receipt) return null;
    return { status, receipt };
  }

  const identity = readOutcomeIdentity(input);
  if (!identity) return null;
  if (status === "failed") {
    if (!hasOnlyKeys(input, SAVE_FAILURE_KEYS)) return null;
    const code = ownField(input, "code");
    if (!isOneOf(code, MEDIA_SAVE_FAILURE_CODES)) return null;
    return {
      status,
      requestId: identity.requestId,
      key: identity.key,
      contentFingerprint: identity.contentFingerprint,
      code
    };
  }
  if (status === "cancelled") {
    if (!hasOnlyKeys(input, CANCELLED_RESULT_KEYS)) return null;
    return {
      status,
      requestId: identity.requestId,
      key: identity.key,
      contentFingerprint: identity.contentFingerprint
    };
  }
  return null;
}

function decodeWorldCaptureMediaSaveReceipt(
  input: unknown
): WorldCaptureMediaSaveReceipt | null {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, RECEIPT_KEYS)) return null;
  const identity = readOutcomeIdentity(input);
  if (!identity) return null;
  const media = decodeWorldCaptureMediaMetadata(ownField(input, "media"));
  if (!media.ok) return null;
  return {
    requestId: identity.requestId,
    key: identity.key,
    contentFingerprint: identity.contentFingerprint,
    media: media.value
  };
}

function readOutcomeIdentity(
  input: Record<string, unknown>
): { requestId: WorldId; key: WorldCaptureVersionKey; contentFingerprint: string } | null {
  const requestId = ownField(input, "requestId");
  if (!isNonEmptyWorldId(requestId)) return null;
  const key = decodeWorldCaptureVersionKey(ownField(input, "key"));
  if (!key.ok) return null;
  const contentFingerprint = ownField(input, "contentFingerprint");
  if (!isWorldCaptureContentFingerprint(contentFingerprint)) return null;
  return { requestId, key: key.value, contentFingerprint };
}

/**
 * Distinguish a structurally invalid image payload from a totally malformed
 * producer outcome when both fail the strict decoder.
 */
function isImageOutcomeForRequest(input: unknown, request: WorldCaptureRequest): boolean {
  if (!isJsonRecord(input) || ownField(input, "status") !== "image") return false;
  const identity = readOutcomeIdentity(input);
  return (
    identity !== null &&
    identity.requestId === request.requestId &&
    worldCaptureVersionKeysEqual(identity.key, request.key) &&
    identity.contentFingerprint === request.contentFingerprint
  );
}

function saveBelongsTo(
  saved: WorldCaptureMediaSaveResult,
  request: WorldCaptureRequest
): boolean {
  const requestId =
    saved.status === "saved" ? saved.receipt.requestId : saved.requestId;
  const key = saved.status === "saved" ? saved.receipt.key : saved.key;
  const contentFingerprint =
    saved.status === "saved" ? saved.receipt.contentFingerprint : saved.contentFingerprint;
  return (
    requestId === request.requestId &&
    worldCaptureVersionKeysEqual(key, request.key) &&
    contentFingerprint === request.contentFingerprint
  );
}

function imageMatchesRequest(request: WorldCaptureRequest, image: WorldCaptureImage): boolean {
  return (
    image.width === request.output.width &&
    image.height === request.output.height &&
    image.contentType === request.output.contentType
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T
): value is T[number] {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
