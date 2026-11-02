/**
 * Immutable model content pinning for static shared-world capture (T09/T10).
 *
 * The capture port originally carried only `WorldInstanceData` (identity plus pose) and
 * opaque version labels. Two canonical snapshots can therefore share an instance id and
 * pose while their model script or GLB asset differs; the old request had no way to
 * reproduce the old geometry and could silently render whatever the current node now
 * contains.
 *
 * This module closes that gap with real canonical model types, not with another version
 * label:
 *
 * - `WorldCaptureScriptModelContent` embeds the complete `ModelDefinition` (source,
 *   language, API version, content version and local placement). The declared
 *   `sourceHash` / `contentHash` are recomputed from that content during decode, so a
 *   producer cannot self-report an identity that does not belong to the bytes it sends.
 * - `WorldCaptureGlbModelContent` embeds the existing `GlbModelReference` (content
 *   addressed `assetId`, content version and placement). Its GLB source/content hashes
 *   are likewise recomputed, not trusted.
 * - `worldCaptureContentFingerprint` folds the actual pinned content of every covered
 *   instance into one deterministic identity. The capture request stores it and every
 *   producer outcome echoes it, so a result produced from a different model version is
 *   rejected even when the instance id/pose and opaque key labels are unchanged.
 *
 * T10 derives these values from the immutable canonical snapshot when it creates the
 * request. T09 must prepare resources through
 * `WorldCaptureContentResolutionPort`, whose input is only the pinned content. The port
 * is required to resolve by content identity and never by "the current node for this
 * instance id"; if an old asset was replaced, evicted or cannot be restored it returns
 * `unavailable` / `waiting` instead of substituting current geometry.
 *
 * This module owns no storage, scheduler, renderer or second canonical world. It is a
 * pure codec plus a typed trusted-port boundary.
 */

import { fnv1a64Hex } from "./content-hash.js";
import {
  decodeGlbModelReference,
  decodeModelDefinition,
  glbModelContentHash,
  glbModelSourceHash,
  modelContentHash,
  modelSourceHash,
  placementKey,
  type GlbModelReference,
  type ModelDefinition
} from "./model-definition.js";
import {
  PREPARED_MODEL_RESOURCE_VERSION,
  type PreparedModelResource
} from "./prepared-model.js";
import {
  codecFailureError,
  decodeFailure,
  hasOnlyKeys,
  isJsonRecord,
  isNonEmptyWorldId,
  ownField
} from "./shared-world-codec.js";
import type { SharedWorldDecodeResult, WorldId } from "./shared-world.js";

/** Envelope version of one pinned model content value. */
export const WORLD_CAPTURE_MODEL_CONTENT_VERSION = "world-capture-model-content-v1" as const;
/** Envelope version of a trusted content-resolution answer. */
export const WORLD_CAPTURE_CONTENT_RESOLUTION_VERSION =
  "world-capture-content-resolution-v1" as const;

const CONTENT_KEYS = ["version", "kind", "definition"] as const;
const GLB_CONTENT_KEYS = ["version", "kind", "reference"] as const;
const DEFINITION_KEYS = [
  "modelScript",
  "modelScriptLanguage",
  "modelScriptVersion",
  "contentVersion",
  "placement"
] as const;
const GLB_REFERENCE_KEYS = ["assetId", "contentVersion", "placement"] as const;
const CONTENT_VERSION_KEYS = ["revision", "sourceHash", "contentHash"] as const;
const PLACEMENT_KEYS = ["offset", "scale", "yaw"] as const;
const OFFSET_KEYS = ["x", "y", "z"] as const;

const INSTANCE_CONTENT_KEYS = ["instanceId", "content"] as const;
const RESOLUTION_REQUEST_KEYS = ["requestId", "contentFingerprint", "instances"] as const;
const RESOLVED_MODEL_KEYS = ["instanceId", "contentHash", "resource"] as const;
const PREPARED_RESOURCE_KEYS = [
  "resourceVersion",
  "sceneVersion",
  "signature",
  "resourceKey",
  "ops",
  "aabb",
  "extent",
  "payload"
] as const;

const CONTENT_FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/;
const WAITING_REASONS = ["resources-not-ready"] as const;
const UNAVAILABLE_REASONS = ["content-unavailable", "content-replaced"] as const;
const FAILURE_CODES = ["content-mismatch"] as const;

/** Script content: the existing self-contained canonical model definition. */
export interface WorldCaptureScriptModelContent {
  readonly version: typeof WORLD_CAPTURE_MODEL_CONTENT_VERSION;
  readonly kind: "script";
  readonly definition: ModelDefinition;
}

/** GLB content: the existing canvas-scoped asset reference. */
export interface WorldCaptureGlbModelContent {
  readonly version: typeof WORLD_CAPTURE_MODEL_CONTENT_VERSION;
  readonly kind: "glb";
  readonly reference: GlbModelReference;
}

export type WorldCaptureModelContent =
  | WorldCaptureScriptModelContent
  | WorldCaptureGlbModelContent;

/** One instance identity bound to the exact model content it had at request time. */
export interface WorldCaptureInstanceContent {
  readonly instanceId: WorldId;
  readonly content: WorldCaptureModelContent;
}

export type WorldCaptureContentWaitingReason = (typeof WAITING_REASONS)[number];
export type WorldCaptureContentUnavailableReason = (typeof UNAVAILABLE_REASONS)[number];
export type WorldCaptureContentFailureCode = (typeof FAILURE_CODES)[number];

/**
 * One prepared resource that the trusted port resolved for a pinned content hash. The
 * resource is the real `PreparedModelResource` (Scene IR signature + registration
 * payload) so T09 can render it without reading the current scene.
 */
export interface WorldCaptureResolvedModelContent {
  readonly instanceId: WorldId;
  readonly contentHash: string;
  readonly resource: PreparedModelResource;
}

export type WorldCaptureContentResolution =
  | {
      readonly version: typeof WORLD_CAPTURE_CONTENT_RESOLUTION_VERSION;
      readonly status: "ready";
      readonly requestId: WorldId;
      readonly contentFingerprint: string;
      readonly resources: readonly WorldCaptureResolvedModelContent[];
    }
  | {
      readonly version: typeof WORLD_CAPTURE_CONTENT_RESOLUTION_VERSION;
      readonly status: "waiting";
      readonly requestId: WorldId;
      readonly contentFingerprint: string;
      readonly reason: WorldCaptureContentWaitingReason;
    }
  | {
      readonly version: typeof WORLD_CAPTURE_CONTENT_RESOLUTION_VERSION;
      readonly status: "unavailable";
      readonly requestId: WorldId;
      readonly contentFingerprint: string;
      readonly reason: WorldCaptureContentUnavailableReason;
    }
  | {
      readonly version: typeof WORLD_CAPTURE_CONTENT_RESOLUTION_VERSION;
      readonly status: "failed";
      readonly requestId: WorldId;
      readonly contentFingerprint: string;
      readonly code: WorldCaptureContentFailureCode;
    };

/** Immutable input to the trusted resolver. It intentionally carries no capture key. */
export interface WorldCaptureContentResolutionRequest {
  readonly requestId: WorldId;
  readonly contentFingerprint: string;
  readonly instances: readonly WorldCaptureInstanceContent[];
}

export interface WorldCaptureContentResolutionPort {
  /**
   * Resolve only the immutable content in `request.instances`. Implementations must not
   * look up "the current model for this instance id" when the pinned content is missing.
   */
  resolve(
    request: WorldCaptureContentResolutionRequest
  ): Promise<WorldCaptureContentResolution>;
}

export type WorldCaptureContentResolutionVerification =
  | { readonly ok: true; readonly resolution: WorldCaptureContentResolution }
  | { readonly ok: false; readonly code: "invalid-data" | "content-mismatch" };

/** True for the deterministic 16-hex fingerprints this module emits. */
export function isWorldCaptureContentFingerprint(value: unknown): value is string {
  return typeof value === "string" && CONTENT_FINGERPRINT_PATTERN.test(value);
}

/**
 * Deterministic fingerprint of the actual pinned content. Instance order never matters;
 * the instance identity, model source/asset and placement do. Content versions are
 * validated at decode time, so this is derived from content rather than trusted labels.
 */
export function worldCaptureContentFingerprint(
  instances: readonly WorldCaptureInstanceContent[]
): string {
  const entries = instances
    .map(instance => `${instance.instanceId}\u0000${contentCanonical(instance.content)}`)
    .sort();
  return fnv1a64Hex(["world-capture-content-v1", ...entries].join("\u0001"));
}

/** Fingerprint of a subject with no instance content (a missing bound target). */
export const EMPTY_WORLD_CAPTURE_CONTENT_FINGERPRINT = worldCaptureContentFingerprint([]);

/** The canonical content hash carried by a pinned script or GLB content value. */
export function worldCaptureModelContentHash(content: WorldCaptureModelContent): string {
  return content.kind === "script"
    ? content.definition.contentVersion.contentHash
    : content.reference.contentVersion.contentHash;
}

/** Decode one exact script or GLB content value and recompute its content identity. */
export function createWorldCaptureModelContent(
  input: unknown
): SharedWorldDecodeResult<WorldCaptureModelContent> {
  if (!isJsonRecord(input)) return decodeFailure("invalid-data", input);
  const version = ownField(input, "version");
  if (version !== WORLD_CAPTURE_MODEL_CONTENT_VERSION) {
    return decodeFailure("unsupported-version", input);
  }
  const kind = ownField(input, "kind");
  if (kind === "script") return decodeScriptContent(input);
  if (kind === "glb") return decodeGlbContent(input);
  return decodeFailure("invalid-data", input);
}

/** Decode an exact one-to-one instance/content set with unique instance identities. */
export function createWorldCaptureInstanceContents(
  input: unknown
): SharedWorldDecodeResult<readonly WorldCaptureInstanceContent[]> {
  if (!Array.isArray(input)) return decodeFailure("invalid-data", input);
  const contents: WorldCaptureInstanceContent[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const decoded = decodeInstanceContent(raw);
    if (!decoded.ok) return decodeFailure(decoded.code, input);
    if (seen.has(decoded.value.instanceId)) return decodeFailure("invalid-data", input);
    seen.add(decoded.value.instanceId);
    contents.push(decoded.value);
  }
  return { ok: true, value: deepFreeze(contents) };
}

/** Decode and deep-freeze an immutable content-resolution request. */
export function decodeWorldCaptureContentResolutionRequest(
  input: unknown
): SharedWorldDecodeResult<WorldCaptureContentResolutionRequest> {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, RESOLUTION_REQUEST_KEYS)) {
    return decodeFailure("invalid-data", input);
  }
  const requestId = ownField(input, "requestId");
  const contentFingerprint = ownField(input, "contentFingerprint");
  if (!isNonEmptyWorldId(requestId) || !isWorldCaptureContentFingerprint(contentFingerprint)) {
    return decodeFailure("invalid-data", input);
  }
  const instances = createWorldCaptureInstanceContents(ownField(input, "instances"));
  if (!instances.ok) return decodeFailure(instances.code, input);
  if (contentFingerprint !== worldCaptureContentFingerprint(instances.value)) {
    return decodeFailure("invalid-data", input);
  }
  return {
    ok: true,
    value: deepFreeze({ requestId, contentFingerprint, instances: instances.value })
  };
}

/**
 * Verify a trusted resolution against the pinned content. A ready answer must cover
 * exactly the pinned instance set and echo each pinned content hash. A resolution for
 * content that is not the pinned content reports `content-mismatch`; it is never
 * accepted by falling back to the current model.
 */
export function verifyWorldCaptureContentResolution(
  request: WorldCaptureContentResolutionRequest,
  resolution: unknown
): WorldCaptureContentResolutionVerification {
  const decodedRequest = decodeWorldCaptureContentResolutionRequest(request);
  if (!decodedRequest.ok) {
    throw codecFailureError(decodedRequest.code, "世界捕获内容解析请求");
  }
  const pinned = decodedRequest.value;

  const decoded = decodeContentResolution(resolution);
  if (!decoded) return { ok: false, code: "invalid-data" };
  if (decoded.requestId !== pinned.requestId) return { ok: false, code: "invalid-data" };
  if (decoded.contentFingerprint !== pinned.contentFingerprint) {
    return { ok: false, code: "content-mismatch" };
  }
  if (decoded.status !== "ready") return { ok: true, resolution: decoded };

  const expected = new Map(
    pinned.instances.map(instance => [
      instance.instanceId,
      worldCaptureModelContentHash(instance.content)
    ])
  );
  if (decoded.resources.length !== expected.size) {
    return { ok: false, code: "content-mismatch" };
  }
  const seen = new Set<string>();
  for (const resolved of decoded.resources) {
    const contentHash = expected.get(resolved.instanceId);
    if (
      contentHash === undefined ||
      seen.has(resolved.instanceId) ||
      resolved.contentHash !== contentHash
    ) {
      return { ok: false, code: "content-mismatch" };
    }
    seen.add(resolved.instanceId);
  }
  return { ok: true, resolution: decoded };
}

function decodeScriptContent(
  input: Record<string, unknown>
): SharedWorldDecodeResult<WorldCaptureScriptModelContent> {
  if (!hasOnlyKeys(input, CONTENT_KEYS)) return decodeFailure("invalid-data", input);
  const raw = ownField(input, "definition");
  if (!isJsonRecord(raw) || !hasOnlyKeys(raw, DEFINITION_KEYS)) {
    return decodeFailure("invalid-data", input);
  }
  if (!hasExactNestedVersionAndPlacement(ownField(raw, "contentVersion"), ownField(raw, "placement"))) {
    return decodeFailure("invalid-data", input);
  }
  const definition = decodeModelDefinition({
    modelScript: ownField(raw, "modelScript"),
    modelScriptLanguage: ownField(raw, "modelScriptLanguage"),
    modelScriptVersion: ownField(raw, "modelScriptVersion"),
    modelContentVersion: ownField(raw, "contentVersion"),
    modelPlacement: ownField(raw, "placement")
  });
  if (!definition.ok) return decodeFailure("invalid-data", input);
  const value = definition.value;
  if (value.contentVersion.sourceHash !== modelSourceHash(value.modelScript)) {
    return decodeFailure("invalid-data", input);
  }
  if (
    value.contentVersion.contentHash !==
    modelContentHash({
      modelScript: value.modelScript,
      modelScriptLanguage: value.modelScriptLanguage,
      modelScriptVersion: value.modelScriptVersion,
      placement: value.placement
    })
  ) {
    return decodeFailure("invalid-data", input);
  }
  return {
    ok: true,
    value: {
      version: WORLD_CAPTURE_MODEL_CONTENT_VERSION,
      kind: "script",
      definition: value
    }
  };
}

function decodeGlbContent(
  input: Record<string, unknown>
): SharedWorldDecodeResult<WorldCaptureGlbModelContent> {
  if (!hasOnlyKeys(input, GLB_CONTENT_KEYS)) return decodeFailure("invalid-data", input);
  const raw = ownField(input, "reference");
  if (!isJsonRecord(raw) || !hasOnlyKeys(raw, GLB_REFERENCE_KEYS)) {
    return decodeFailure("invalid-data", input);
  }
  if (!hasExactNestedVersionAndPlacement(ownField(raw, "contentVersion"), ownField(raw, "placement"))) {
    return decodeFailure("invalid-data", input);
  }
  const reference = decodeGlbModelReference({
    modelSourceKind: "glb",
    modelAssetId: ownField(raw, "assetId"),
    modelContentVersion: ownField(raw, "contentVersion"),
    modelPlacement: ownField(raw, "placement")
  });
  if (!reference.ok) return decodeFailure("invalid-data", input);
  const value = reference.value;
  if (value.contentVersion.sourceHash !== glbModelSourceHash(value.assetId)) {
    return decodeFailure("invalid-data", input);
  }
  if (
    value.contentVersion.contentHash !==
    glbModelContentHash({ assetId: value.assetId, placement: value.placement })
  ) {
    return decodeFailure("invalid-data", input);
  }
  return {
    ok: true,
    value: {
      version: WORLD_CAPTURE_MODEL_CONTENT_VERSION,
      kind: "glb",
      reference: value
    }
  };
}

function hasExactNestedVersionAndPlacement(
  contentVersion: unknown,
  placement: unknown
): boolean {
  if (!isJsonRecord(contentVersion) || !hasOnlyKeys(contentVersion, CONTENT_VERSION_KEYS)) {
    return false;
  }
  if (!isJsonRecord(placement) || !hasOnlyKeys(placement, PLACEMENT_KEYS)) return false;
  const offset = ownField(placement, "offset");
  return isJsonRecord(offset) && hasOnlyKeys(offset, OFFSET_KEYS);
}

function decodeInstanceContent(
  input: unknown
): SharedWorldDecodeResult<WorldCaptureInstanceContent> {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, INSTANCE_CONTENT_KEYS)) {
    return decodeFailure("invalid-data", input);
  }
  const instanceId = ownField(input, "instanceId");
  if (!isNonEmptyWorldId(instanceId)) return decodeFailure("invalid-data", input);
  const content = createWorldCaptureModelContent(ownField(input, "content"));
  if (!content.ok) return decodeFailure(content.code, input);
  return { ok: true, value: { instanceId, content: content.value } };
}

function decodeContentResolution(input: unknown): WorldCaptureContentResolution | null {
  if (!isJsonRecord(input)) return null;
  if (ownField(input, "version") !== WORLD_CAPTURE_CONTENT_RESOLUTION_VERSION) return null;
  const status = ownField(input, "status");
  const requestId = ownField(input, "requestId");
  const contentFingerprint = ownField(input, "contentFingerprint");
  if (
    !isNonEmptyWorldId(requestId) ||
    !isWorldCaptureContentFingerprint(contentFingerprint)
  ) {
    return null;
  }

  if (status === "ready") {
    if (
      !hasOnlyKeys(input, [
        "version",
        "status",
        "requestId",
        "contentFingerprint",
        "resources"
      ])
    ) {
      return null;
    }
    const rawResources = ownField(input, "resources");
    if (!Array.isArray(rawResources)) return null;
    const resources: WorldCaptureResolvedModelContent[] = [];
    for (const raw of rawResources) {
      const resolved = decodeResolvedModelContent(raw);
      if (!resolved) return null;
      resources.push(resolved);
    }
    return deepFreeze({
      version: WORLD_CAPTURE_CONTENT_RESOLUTION_VERSION,
      status,
      requestId,
      contentFingerprint,
      resources
    });
  }

  if (status === "waiting" || status === "unavailable") {
    if (
      !hasOnlyKeys(input, [
        "version",
        "status",
        "requestId",
        "contentFingerprint",
        "reason"
      ])
    ) {
      return null;
    }
    const reason = ownField(input, "reason");
    if (
      !isOneOf(reason, status === "waiting" ? WAITING_REASONS : UNAVAILABLE_REASONS)
    ) {
      return null;
    }
    return deepFreeze({
      version: WORLD_CAPTURE_CONTENT_RESOLUTION_VERSION,
      status,
      requestId,
      contentFingerprint,
      reason
    } as WorldCaptureContentResolution);
  }

  if (status === "failed") {
    if (
      !hasOnlyKeys(input, [
        "version",
        "status",
        "requestId",
        "contentFingerprint",
        "code"
      ])
    ) {
      return null;
    }
    const code = ownField(input, "code");
    if (!isOneOf(code, FAILURE_CODES)) return null;
    return deepFreeze({
      version: WORLD_CAPTURE_CONTENT_RESOLUTION_VERSION,
      status,
      requestId,
      contentFingerprint,
      code
    });
  }
  return null;
}

function decodeResolvedModelContent(input: unknown): WorldCaptureResolvedModelContent | null {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, RESOLVED_MODEL_KEYS)) return null;
  const instanceId = ownField(input, "instanceId");
  const contentHash = ownField(input, "contentHash");
  if (!isNonEmptyWorldId(instanceId) || !isNonEmptyWorldId(contentHash)) return null;
  const resource = decodePreparedModelResource(ownField(input, "resource"));
  if (!resource) return null;
  return { instanceId, contentHash, resource };
}

function decodePreparedModelResource(input: unknown): PreparedModelResource | null {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, PREPARED_RESOURCE_KEYS)) return null;
  if (ownField(input, "resourceVersion") !== PREPARED_MODEL_RESOURCE_VERSION) return null;
  const sceneVersion = ownField(input, "sceneVersion");
  const signature = ownField(input, "signature");
  const resourceKey = ownField(input, "resourceKey");
  const ops = ownField(input, "ops");
  const aabb = ownField(input, "aabb");
  const extent = ownField(input, "extent");
  const payload = ownField(input, "payload");
  if (
    !isNonEmptyWorldId(sceneVersion) ||
    !isNonEmptyWorldId(signature) ||
    !isNonEmptyWorldId(resourceKey) ||
    typeof payload !== "string" ||
    resourceKey !== `${sceneVersion}:${signature}` ||
    !Array.isArray(ops) ||
    typeof extent !== "number" ||
    !Number.isFinite(extent) ||
    extent < 0 ||
    !isAabbOrNull(aabb)
  ) {
    return null;
  }
  try {
    return structuredClone({
      resourceVersion: PREPARED_MODEL_RESOURCE_VERSION,
      sceneVersion,
      signature,
      resourceKey,
      ops,
      aabb,
      extent,
      payload
    }) as PreparedModelResource;
  } catch {
    return null;
  }
}

function isAabbOrNull(value: unknown): boolean {
  if (value === null) return true;
  if (!isJsonRecord(value) || !hasOnlyKeys(value, ["min", "max"])) return false;
  return isVec3(ownField(value, "min")) && isVec3(ownField(value, "max"));
}

function isVec3(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(component => typeof component === "number" && Number.isFinite(component))
  );
}

function contentCanonical(content: WorldCaptureModelContent): string {
  return content.kind === "script"
    ? [
        "script",
        content.definition.modelScriptLanguage,
        content.definition.modelScriptVersion,
        content.definition.modelScript,
        placementKey(content.definition.placement)
      ].join("\u0000")
    : ["glb", content.reference.assetId, placementKey(content.reference.placement)].join("\u0000");
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
