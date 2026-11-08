/**
 * Static shared-world capture pipeline contract (T10 implementation).
 *
 * This module is the public seam between the capture scheduler owned by the canvas
 * service and the renderer producer owned by T09:
 *
 * - T09 registers one `WorldCaptureProducer`. The producer receives an immutable
 *   `WorldCaptureRequest` (already pinned by the canonical snapshot) and may resolve
 *   pinned model content through the trusted content port.
 * - The producer reports `waiting` when resources are not ready, then calls
 *   `notifyResourcesReady` after the renderer has them. A browser/Bevy producer may
 *   call the same method from the host integration route.
 * - The pipeline ignores late results, produces a `WorldCaptureGenerationBinding`
 *   only from verified v2 media, and lets generation acceptance claim exactly that
 *   binding. Self-reported request keys, storage keys or checksums are never trusted
 *   on their own.
 *
 * The types here contain no scheduler, queue, media I/O or renderer handle. They keep
 * opaque versions comparable only for equality and never invent a second world model.
 */

import type { WorldCaptureInput, WorldCaptureVersionKey } from "./shared-world.js";
import { codecFailureError, decodeFailure, hasOnlyKeys, isJsonRecord, isNonEmptyWorldId, ownField } from "./shared-world-codec.js";
import type { SharedWorldDecodeResult, WorldId } from "./shared-world.js";
import {
  decodeWorldCaptureMediaMetadata,
  decodeWorldCaptureVersionKey,
  encodeWorldCaptureMediaMetadata,
  encodeWorldCaptureVersionKey,
  worldCaptureVersionKeysEqual,
  type WorldCaptureMediaMetadata
} from "./world-capture-contract.js";
import {
  isWorldCaptureContentFingerprint,
  type WorldCaptureContentResolutionPort
} from "./world-capture-content-contract.js";
import {
  decodeWorldCaptureVideoMediaMetadata,
  encodeWorldCaptureVideoMediaMetadata,
  type WorldCaptureDynamicProducerOutcome,
  type WorldCaptureDynamicRequest,
  type WorldCaptureVideoFrozenInput,
  type WorldCaptureVideoMediaMetadata
} from "./world-capture-dynamic-contract.js";
import type {
  WorldCaptureProducerOutcome,
  WorldCaptureRequest
} from "./world-capture-port-contract.js";

/**
 * Version of the generation binding envelope.
 *
 * v2 adds the optional `video` envelope for动态镜头. v1 bindings persisted by older
 * builds keep decoding (they can only carry an image `media`); new claims always write
 * v2 so a video asset can never be mistaken for an image reference.
 */
export const WORLD_CAPTURE_GENERATION_BINDING_VERSION = "world-capture-generation-binding-v2" as const;
/** Legacy envelope still read from persisted jobs; never written again. */
export const LEGACY_WORLD_CAPTURE_GENERATION_BINDING_VERSION = "world-capture-generation-binding-v1" as const;

const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;
const BINDING_KEYS = ["version", "requestId", "key", "contentFingerprint", "input", "media"] as const;
const BINDING_V2_KEYS = ["version", "requestId", "key", "contentFingerprint", "input", "media", "video"] as const;
const READY_NOTICE_KEYS = ["canvasId", "cameraId", "requestId", "contentFingerprint"] as const;

/**
 * A renderer producer registered by T09. The pipeline owns request creation, current
 * key comparison, media verification and freezing; the producer only renders the
 * immutable request it was given.
 */
export interface WorldCaptureProducer {
  /**
   * Stable opaque producer identity for diagnostics and duplicate registration
   * checks. It never grants authority and must not be a business branch in the host.
   */
  readonly producerId: string;
  capture(
    request: WorldCaptureRequest,
    options?: { readonly signal?: AbortSignal }
  ): Promise<WorldCaptureProducerOutcome>;
  /**
   * Optional trusted resource resolver. When present the pipeline resolves the pinned
   * content before rendering and rejects a result for different content. A producer
   * that renders directly from `request.subject` may omit it, but must still render
   * exactly the pinned content (never the mutable current scene).
   */
  readonly resolveContent?: WorldCaptureContentResolutionPort;
  /**
   * Dynamic (video) capture for cameras derived as `dynamic`. Producers without a
   * real video encoder MUST omit it; the scheduler then reports an explicit
   * unavailable reason instead of silently returning a static image.
   */
  readonly captureVideo?: (
    request: WorldCaptureDynamicRequest,
    options?: { readonly signal?: AbortSignal }
  ) => Promise<WorldCaptureDynamicProducerOutcome>;
}

export interface WorldCaptureProducerRegistration {
  readonly producerId: string;
  /** Idempotent; removes only the exact registered producer. */
  unregister(): void;
}

/** Late renderer notification that pinned resources have become ready. */
export interface WorldCaptureResourceReadyNotice {
  readonly canvasId: WorldId;
  readonly cameraId?: WorldId;
  /** When present, only this exact attempt is retried (late/old notices are ignored). */
  readonly requestId?: WorldId;
  readonly contentFingerprint?: string;
}

/**
 * Stable association produced only after trusted media verification. Generation
 * acceptance stores this binding so later canvas changes cannot rewrite the input.
 */
export interface WorldCaptureGenerationBinding {
  readonly version: typeof WORLD_CAPTURE_GENERATION_BINDING_VERSION;
  readonly requestId: WorldId;
  readonly key: WorldCaptureVersionKey;
  readonly contentFingerprint: string;
  readonly input: WorldCaptureInput;
  /**
   * Exact verified v2 media metadata. New claims always carry it so generation can
   * materialize the same bytes as a reference input without reading the current
   * camera or storage head. It stays optional for previously persisted bindings;
   * consumers that need a reference must fail closed when it is absent.
   */
  readonly media?: WorldCaptureMediaMetadata;
  /**
   * Exact verified video envelope for a dynamic camera shot. Absent for static
   * (image) framings; never combined with `media`.
   */
  readonly video?: WorldCaptureVideoMediaMetadata;
}

export type WorldCaptureFramingPhase =
  | "empty"
  | "capturing"
  | "waiting"
  | "ready"
  | "failed"
  | "unavailable"
  | "cancelled";

/**
 * Public framing status. `input` is the last verified framing and may still be
 * displayed for viewing, but `stale: true` means it is not the current valid input
 * and generation must not consume it.
 */
export interface WorldCaptureFramingStatus {
  readonly canvasId: WorldId;
  readonly cameraId: WorldId;
  readonly key: WorldCaptureVersionKey | null;
  /** Full frozen animation/range/profile identity for explicit video frame derivation. */
  readonly dynamicKey?: import("./world-capture-dynamic-contract.js").WorldCaptureDynamicVersionKey;
  readonly phase: WorldCaptureFramingPhase;
  readonly stale: boolean;
  readonly requestId?: WorldId;
  readonly contentFingerprint?: string;
  readonly input?: WorldCaptureInput;
  /** 卡片语义：`dynamic` 表示该镜头代表视频，不只是图片。 */
  readonly shotKind?: "static" | "dynamic";
  /** 动态镜头关联的动画时长（秒）；静止镜头缺省。 */
  readonly durationSeconds?: number;
  /** 当前键已冻结的视频媒体（仅动态镜头且 ready 时存在）。 */
  readonly video?: WorldCaptureVideoMediaMetadata;
  /** Current output pixels of the last captured key (not byte size). */
  readonly width?: number;
  readonly height?: number;
  readonly reason?: string;
}

export type WorldCaptureRefreshFailureCode =
  | "canvas-not-found"
  | "camera-not-found"
  | "capture-unavailable"
  | "unsupported-capture-mode"
  | "duration-exceeded"
  | "fps-out-of-range"
  | "invalid-data"
  | "producer-missing";

export type WorldCaptureRefreshOutcome =
  | { readonly ok: true; readonly status: WorldCaptureFramingStatus }
  | {
      readonly ok: false;
      readonly code: WorldCaptureRefreshFailureCode;
      readonly message: string;
      readonly status?: WorldCaptureFramingStatus;
    };

export type WorldCaptureFreezeFailureCode =
  | "canvas-not-found"
  | "camera-not-found"
  | "capture-unavailable"
  | "capture-not-ready"
  | "cancelled"
  | "superseded"
  | "timeout"
  | "unsupported-capture-mode"
  | "dynamic-capture-unsupported"
  | "duration-exceeded"
  | "fps-out-of-range"
  | "invalid-data"
  | "request-conflict";

export type WorldCaptureFreezeOutcome =
  | { readonly ok: true; readonly binding: WorldCaptureGenerationBinding }
  | {
      readonly ok: false;
      readonly code: WorldCaptureFreezeFailureCode;
      readonly message: string;
      readonly requestedKey?: WorldCaptureVersionKey;
      readonly currentKey?: WorldCaptureVersionKey;
      readonly status?: WorldCaptureFramingStatus;
    };

/** Result of validating a completed freeze immediately before durable acceptance. */
export type WorldCaptureClaimOutcome =
  | { readonly ok: true; readonly binding: WorldCaptureGenerationBinding }
  | { readonly ok: false; readonly code: "unknown-capture" | "capture-expired" | "capture-mismatch"; readonly message: string };

/** Decode one exact public binding; no field is inferred or defaulted. */
export function decodeWorldCaptureGenerationBinding(
  input: unknown
): SharedWorldDecodeResult<WorldCaptureGenerationBinding> {
  if (!isJsonRecord(input)) return decodeFailure("invalid-data", input);
  const version = ownField(input, "version");
  if (version !== WORLD_CAPTURE_GENERATION_BINDING_VERSION && version !== LEGACY_WORLD_CAPTURE_GENERATION_BINDING_VERSION) {
    return decodeFailure("unsupported-version", input);
  }
  if (version === WORLD_CAPTURE_GENERATION_BINDING_VERSION) {
    if (!hasOnlyKeys(input, BINDING_V2_KEYS)) return decodeFailure("invalid-data", input);
  } else if (!hasOnlyKeys(input, BINDING_KEYS)) {
    return decodeFailure("invalid-data", input);
  }
  const requestId = ownField(input, "requestId");
  const contentFingerprint = ownField(input, "contentFingerprint");
  if (!isNonEmptyWorldId(requestId) || !isWorldCaptureContentFingerprint(contentFingerprint)) {
    return decodeFailure("invalid-data", input);
  }
  const key = decodeWorldCaptureVersionKey(ownField(input, "key"));
  if (!key.ok) return decodeFailure(key.code, input);
  const inputValue = decodeWorldCaptureInput(ownField(input, "input"));
  if (!inputValue.ok) return decodeFailure(inputValue.code, input);
  if (!worldCaptureVersionKeysEqual(key.value, inputValue.value.key)) {
    return decodeFailure("invalid-data", input);
  }
  const rawMedia = ownField(input, "media");
  const media = rawMedia === undefined ? undefined : decodeWorldCaptureMediaMetadata(rawMedia);
  if (media && !media.ok) return decodeFailure(media.code, input);
  if (
    media?.ok &&
    (media.value.mediaId !== inputValue.value.mediaId ||
      media.value.checksum !== inputValue.value.checksum)
  ) {
    return decodeFailure("invalid-data", input);
  }
  const rawVideo = ownField(input, "video");
  const video = rawVideo === undefined ? undefined : decodeWorldCaptureVideoMediaMetadata(rawVideo);
  if (video && !video.ok) {
    return decodeFailure(video.code === "unsupported-version" ? "unsupported-version" : "invalid-data", input);
  }
  if (media?.ok && video?.ok) return decodeFailure("invalid-data", input);
  if (
    video?.ok &&
    (video.value.mediaId !== inputValue.value.mediaId ||
      video.value.checksum !== inputValue.value.checksum)
  ) {
    return decodeFailure("invalid-data", input);
  }
  return {
    ok: true,
    value: {
      version: WORLD_CAPTURE_GENERATION_BINDING_VERSION,
      requestId,
      key: key.value,
      contentFingerprint,
      input: inputValue.value,
      ...(media?.ok ? { media: media.value } : {}),
      ...(video?.ok ? { video: video.value } : {})
    }
  };
}

/**
 * Build a v2 binding from a verified dynamic video freeze. Only called after
 * `freezeWorldCaptureVideoInput` succeeded, so the base key and media identity already
 * belong to the same frozen version.
 */
export function worldCaptureVideoBinding(
  requestId: WorldId,
  contentFingerprint: string,
  frozen: WorldCaptureVideoFrozenInput
): WorldCaptureGenerationBinding {
  return {
    version: WORLD_CAPTURE_GENERATION_BINDING_VERSION,
    requestId,
    key: frozen.input.key,
    contentFingerprint,
    input: frozen.input,
    video: frozen.media
  };
}

/** Re-validate and canonicalize one binding; throws on invalid data. */
export function encodeWorldCaptureGenerationBinding(
  value: WorldCaptureGenerationBinding
): unknown {
  const decoded = decodeWorldCaptureGenerationBinding(value);
  if (!decoded.ok) throw codecFailureError(decoded.code, "世界捕获生成绑定");
  return {
    version: decoded.value.version,
    requestId: decoded.value.requestId,
    key: encodeWorldCaptureVersionKey(decoded.value.key),
    contentFingerprint: decoded.value.contentFingerprint,
    input: {
      key: encodeWorldCaptureVersionKey(decoded.value.input.key),
      mediaId: decoded.value.input.mediaId,
      checksum: decoded.value.input.checksum
    },
    ...(decoded.value.media
      ? { media: encodeWorldCaptureMediaMetadata(decoded.value.media) }
      : {}),
    ...(decoded.value.video
      ? { video: encodeWorldCaptureVideoMediaMetadata(decoded.value.video) }
      : {})
  };
}

/** Decode a late resource-ready notice. All optional fields remain optional. */
export function decodeWorldCaptureResourceReadyNotice(
  input: unknown
): SharedWorldDecodeResult<WorldCaptureResourceReadyNotice> {
  if (!isJsonRecord(input)) return decodeFailure("invalid-data", input);
  const canvasId = ownField(input, "canvasId");
  if (!isNonEmptyWorldId(canvasId)) return decodeFailure("invalid-data", input);
  const cameraId = ownField(input, "cameraId");
  const requestId = ownField(input, "requestId");
  const contentFingerprint = ownField(input, "contentFingerprint");
  if (cameraId !== undefined && !isNonEmptyWorldId(cameraId)) return decodeFailure("invalid-data", input);
  if (requestId !== undefined && !isNonEmptyWorldId(requestId)) return decodeFailure("invalid-data", input);
  if (
    contentFingerprint !== undefined &&
    (typeof contentFingerprint !== "string" || !isWorldCaptureContentFingerprint(contentFingerprint))
  ) {
    return decodeFailure("invalid-data", input);
  }
  const allowed = new Set<string>(READY_NOTICE_KEYS);
  if (!Object.keys(input).every(key => allowed.has(key))) return decodeFailure("invalid-data", input);
  return {
    ok: true,
    value: {
      canvasId,
      ...(cameraId !== undefined ? { cameraId } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
      ...(contentFingerprint !== undefined ? { contentFingerprint } : {})
    }
  };
}

function decodeWorldCaptureInput(input: unknown): SharedWorldDecodeResult<WorldCaptureInput> {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, ["key", "mediaId", "checksum"])) {
    return decodeFailure("invalid-data", input);
  }
  const key = decodeWorldCaptureVersionKey(ownField(input, "key"));
  if (!key.ok) return decodeFailure(key.code, input);
  const mediaId = ownField(input, "mediaId");
  const checksum = ownField(input, "checksum");
  if (!isNonEmptyWorldId(mediaId)) return decodeFailure("invalid-data", input);
  if (typeof checksum !== "string" || !CHECKSUM_PATTERN.test(checksum)) {
    return decodeFailure("invalid-data", input);
  }
  return { ok: true, value: { key: key.value, mediaId, checksum } };
}

/** A page reports progress for one host-issued attempt; it cannot publish ready. */
export type WorldCapturePageProgress = {
  cameraId: string;
  attemptId: string;
  stage: "rendering" | "encoding" | "uploading" | "failed";
  completedFrames?: number;
  totalFrames?: number;
  reason?: string;
};
