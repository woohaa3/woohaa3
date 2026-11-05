/**
 * 动态取景契约（change: 2026-11-05-camera-shot-as-video，design D3/D4/D7）。
 *
 * 与静态取景契约分开：动态取景额外冻结动画版本（导演区 + 脚本 revision +
 * sourceHash + 时长）、时间区间、fps 与视频输出规格；静态契约继续只接受图片。
 *
 * 纯边界模块：不含调度、渲染、编码、存储或网络。它只证明
 * - 一个请求的冻结身份（相等是唯一有效判据）；
 * - 一次结果是否属于当前有效版本（迟到/取消/替换的结果不得发布）；
 * - 视频媒体元数据确实是视频（容器、时长、fps、像素尺寸、checksum、storageKey）。
 */
import {
  decodeWorldInstanceData,
  hasOnlyKeys,
  isJsonRecord,
  isNonEmptyWorldId,
  ownField
} from "./shared-world-codec.js";
import type { ServerCanvas } from "./domain/types.js";
import type {
  WorldCameraData,
  WorldCaptureInput,
  WorldCaptureVersionKey,
  WorldId,
  WorldInstanceData,
  WorldVersion
} from "./shared-world.js";
import { decodeWorldCaptureVersionKey } from "./world-capture-contract.js";
import {
  createWorldCaptureInstanceContents,
  createWorldCaptureModelContent,
  isWorldCaptureContentFingerprint,
  worldCaptureContentFingerprint,
  type WorldCaptureInstanceContent,
  type WorldCaptureModelContent
} from "./world-capture-content-contract.js";
import { decodeWorldCamera } from "./world-camera-codec.js";

export const WORLD_CAPTURE_DYNAMIC_REQUEST_VERSION = "world-capture-dynamic-request-v1" as const;
export const WORLD_CAPTURE_VIDEO_MEDIA_VERSION = "world-capture-video-media-v1" as const;
export const WORLD_CAPTURE_DYNAMIC_CONTAINER = "video/mp4" as const;
export const WORLD_CAPTURE_DYNAMIC_DEFAULT_FPS = 24;
export const WORLD_CAPTURE_DYNAMIC_MIN_FPS = 1;
export const WORLD_CAPTURE_DYNAMIC_MAX_FPS = 60;
/** 单次动态捕获上限：超限必须显式缩短区间，不能静默截断（design D3、任务 3.4）。 */
export const WORLD_CAPTURE_DYNAMIC_MAX_DURATION_SECONDS = 60;
/** 动态取景默认输出长边：像素粒度与静态一致，但编码成本按秒增长。 */
export const WORLD_CAPTURE_DYNAMIC_OUTPUT_LONG_EDGE = 1024;

const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;
const VIDEO_CONTENT_TYPE_PATTERN = /^video\/[a-z0-9][a-z0-9.+-]{0,127}$/;

export type WorldCaptureDynamicDecodeCode =
  | "invalid-data"
  | "unsupported-version"
  | "duration-exceeded"
  | "fps-out-of-range"
  | "unsupported-container";

export type WorldCaptureDynamicDecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: WorldCaptureDynamicDecodeCode; readonly input: unknown };

function decodeFailure<T>(code: WorldCaptureDynamicDecodeCode, input: unknown): WorldCaptureDynamicDecodeResult<T> {
  return { ok: false, code, input };
}

function codecFailureError(code: WorldCaptureDynamicDecodeCode, label: string): Error {
  return new Error(`${label} 不是可持久化的动态取景配置：${code}`);
}

export type WorldCaptureAnimationVersion = {
  readonly areaId: WorldId;
  readonly scriptRevision: number;
  readonly sourceHash: string;
  /** 脚本时长（秒）；时间区间必须落在其中。 */
  readonly durationSeconds: number;
};

export type WorldCaptureTimeRange = {
  readonly startSeconds: number;
  readonly endSeconds: number;
};

export type WorldCaptureDynamicOutput = {
  readonly outputVersion: WorldVersion;
  readonly width: number;
  readonly height: number;
  readonly container: typeof WORLD_CAPTURE_DYNAMIC_CONTAINER;
};

/**
 * 完整冻结键。`outputVersion` 由容器、尺寸、fps、时间区间与动画版本共同派生，
 * 因此基础六字段键相等就足以证明动态版本相等。
 */
export type WorldCaptureDynamicVersionKey = {
  readonly canvasId: WorldId;
  readonly cameraId: WorldId;
  readonly worldContentVersion: WorldVersion;
  readonly cameraSettingsVersion: WorldVersion;
  readonly bindingVersion: WorldVersion;
  readonly outputVersion: WorldVersion;
  readonly animation: WorldCaptureAnimationVersion;
  readonly timeRange: WorldCaptureTimeRange;
  readonly fps: number;
};

export type WorldCaptureDynamicWorldSubject = {
  readonly kind: "world";
  readonly instances: readonly WorldInstanceData[];
  readonly contents: readonly WorldCaptureInstanceContent[];
};

export type WorldCaptureDynamicInstanceSubject = {
  readonly kind: "instance";
  readonly instanceId: WorldId;
  readonly instance: WorldInstanceData;
  readonly content: WorldCaptureModelContent;
};

export type WorldCaptureDynamicMissingSubject = {
  readonly kind: "bound-missing";
  readonly instanceId: WorldId;
};

export type WorldCaptureDynamicSubject =
  | WorldCaptureDynamicWorldSubject
  | WorldCaptureDynamicInstanceSubject
  | WorldCaptureDynamicMissingSubject;

export type WorldCaptureDynamicRequest = {
  readonly version: typeof WORLD_CAPTURE_DYNAMIC_REQUEST_VERSION;
  readonly requestId: WorldId;
  readonly key: WorldCaptureDynamicVersionKey;
  readonly camera: WorldCameraData;
  readonly subject: WorldCaptureDynamicSubject;
  readonly output: WorldCaptureDynamicOutput;
  readonly contentFingerprint: string;
};

export type WorldCaptureVideoMediaMetadata = {
  readonly version: typeof WORLD_CAPTURE_VIDEO_MEDIA_VERSION;
  readonly mediaId: WorldId;
  readonly storageKey: string;
  readonly checksum: string;
  readonly size: number;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
  readonly container: typeof WORLD_CAPTURE_DYNAMIC_CONTAINER;
  readonly durationSeconds: number;
  readonly fps: number;
};

/** 编码器/生产者返回的临时视频字节；校验并保存前不是资产。 */
export type WorldCaptureVideo = {
  readonly bytes: Uint8Array;
  readonly contentType: typeof WORLD_CAPTURE_DYNAMIC_CONTAINER;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds: number;
  readonly fps: number;
};

export type WorldCaptureDynamicProducerOutcome =
  | {
      readonly status: "video";
      readonly requestId: WorldId;
      readonly key: WorldCaptureDynamicVersionKey;
      readonly contentFingerprint: string;
      readonly video: WorldCaptureVideo;
    }
  | {
      readonly status: "waiting" | "unavailable";
      readonly requestId: WorldId;
      readonly key: WorldCaptureDynamicVersionKey;
      readonly contentFingerprint: string;
      readonly reason: string;
    }
  | {
      readonly status: "failed";
      readonly requestId: WorldId;
      readonly key: WorldCaptureDynamicVersionKey;
      readonly contentFingerprint: string;
      readonly code: string;
    }
  | {
      readonly status: "cancelled";
      readonly requestId: WorldId;
      readonly key: WorldCaptureDynamicVersionKey;
      readonly contentFingerprint: string;
    };

export type WorldCaptureDynamicSaveResult =
  | {
      readonly status: "saved";
      readonly requestId: WorldId;
      readonly key: WorldCaptureDynamicVersionKey;
      readonly contentFingerprint: string;
      readonly media: WorldCaptureVideoMediaMetadata;
    }
  | {
      readonly status: "failed";
      readonly requestId: WorldId;
      readonly key: WorldCaptureDynamicVersionKey;
      readonly contentFingerprint: string;
      readonly code: string;
    }
  | {
      readonly status: "cancelled";
      readonly requestId: WorldId;
      readonly key: WorldCaptureDynamicVersionKey;
      readonly contentFingerprint: string;
    };

/** 交给独立可信视频媒体端口保存的临时字节；保存前不是资产。 */
export type WorldCaptureDynamicMediaSaveRequest = {
  readonly requestId: WorldId;
  readonly key: WorldCaptureDynamicVersionKey;
  readonly contentFingerprint: string;
  readonly video: WorldCaptureVideo;
};

/** 可信视频保存端口；实现方负责存储、checksum 与校验。 */
export interface WorldCaptureVideoMediaSavePort {
  save(request: WorldCaptureDynamicMediaSaveRequest): Promise<WorldCaptureDynamicSaveResult>;
}

/**
 * 视频冻结结果。`input` 保持既有 `WorldCaptureInput` 形状（key + mediaId + checksum），
 * 只是 key 的 `outputVersion` 已覆盖动画/区间/fps/容器，因而旧结果无法冒充当前版本。
 */
export type WorldCaptureVideoFrozenInput = {
  readonly version: "world-capture-video-input-v1";
  readonly key: WorldCaptureVersionKey;
  readonly input: WorldCaptureInput;
  readonly media: WorldCaptureVideoMediaMetadata;
};

export type WorldCaptureDynamicResolution =
  | {
      readonly status: "ready";
      readonly requestId: WorldId;
      readonly key: WorldCaptureDynamicVersionKey;
      readonly frozen: WorldCaptureVideoFrozenInput;
    }
  | {
      readonly status: "media-required";
      readonly requestId: WorldId;
      readonly key: WorldCaptureDynamicVersionKey;
      readonly video: WorldCaptureVideo;
    }
  | {
      readonly status: "waiting" | "unavailable";
      readonly requestId: WorldId;
      readonly key: WorldCaptureDynamicVersionKey;
      readonly reason: string;
    }
  | {
      readonly status: "failed";
      readonly requestId: WorldId;
      readonly key: WorldCaptureDynamicVersionKey;
      readonly code: string;
    }
  | {
      readonly status: "cancelled";
      readonly requestId: WorldId;
      readonly key: WorldCaptureDynamicVersionKey;
    }
  | {
      readonly status: "superseded";
      readonly requestId: WorldId;
      readonly requestedKey: WorldCaptureDynamicVersionKey;
      readonly currentKey: WorldCaptureDynamicVersionKey;
    }
  | {
      readonly status: "rejected";
      readonly requestId: WorldId;
      readonly key: WorldCaptureDynamicVersionKey;
      readonly code:
        | "request-mismatch"
        | "content-mismatch"
        | "invalid-data"
        | "invalid-video"
        | "media-unverified";
    };

const ANIMATION_KEYS = ["areaId", "scriptRevision", "sourceHash", "durationSeconds"] as const;
const TIME_RANGE_KEYS = ["startSeconds", "endSeconds"] as const;
const OUTPUT_KEYS = ["outputVersion", "width", "height", "container"] as const;
const KEY_KEYS = [
  "canvasId",
  "cameraId",
  "worldContentVersion",
  "cameraSettingsVersion",
  "bindingVersion",
  "outputVersion",
  "animation",
  "timeRange",
  "fps"
] as const;
const REQUEST_KEYS = [
  "version",
  "requestId",
  "key",
  "camera",
  "subject",
  "output",
  "contentFingerprint"
] as const;
const VIDEO_MEDIA_KEYS = [
  "version",
  "mediaId",
  "storageKey",
  "checksum",
  "size",
  "contentType",
  "width",
  "height",
  "container",
  "durationSeconds",
  "fps"
] as const;
const VIDEO_KEYS = ["bytes", "contentType", "width", "height", "durationSeconds", "fps"] as const;

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFps(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= WORLD_CAPTURE_DYNAMIC_MIN_FPS &&
    value <= WORLD_CAPTURE_DYNAMIC_MAX_FPS
  );
}

/** 帧数按 fps 与实际时长计算，始终恰好在区间内。 */
export function worldCaptureDynamicFrameCount(key: { readonly timeRange: WorldCaptureTimeRange; readonly fps: number }): number {
  const span = key.timeRange.endSeconds - key.timeRange.startSeconds;
  return Math.max(1, Math.round(span * key.fps));
}

/** 第 index 帧的时间点（秒），不超过 `endSeconds`。 */
export function worldCaptureFrameTime(key: { readonly timeRange: WorldCaptureTimeRange; readonly fps: number }, index: number): number {
  const { startSeconds, endSeconds } = key.timeRange;
  if (!(index > 0)) return startSeconds;
  return Math.min(endSeconds, startSeconds + index / key.fps);
}

export function decodeWorldCaptureAnimationVersion(
  input: unknown
): WorldCaptureDynamicDecodeResult<WorldCaptureAnimationVersion> {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, ANIMATION_KEYS)) {
    return decodeFailure("invalid-data", input);
  }
  const areaId = ownField(input, "areaId");
  const scriptRevision = ownField(input, "scriptRevision");
  const sourceHash = ownField(input, "sourceHash");
  const durationSeconds = ownField(input, "durationSeconds");
  if (
    !isNonEmptyWorldId(areaId) ||
    !isPositiveSafeInteger(scriptRevision) ||
    typeof sourceHash !== "string" ||
    sourceHash.trim() === "" ||
    !isFiniteNumber(durationSeconds) ||
    durationSeconds <= 0
  ) {
    return decodeFailure("invalid-data", input);
  }
  return { ok: true, value: { areaId, scriptRevision, sourceHash, durationSeconds } };
}

export function decodeWorldCaptureTimeRange(
  input: unknown
): WorldCaptureDynamicDecodeResult<WorldCaptureTimeRange> {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, TIME_RANGE_KEYS)) {
    return decodeFailure("invalid-data", input);
  }
  const startSeconds = ownField(input, "startSeconds");
  const endSeconds = ownField(input, "endSeconds");
  if (!isFiniteNumber(startSeconds) || !isFiniteNumber(endSeconds)) {
    return decodeFailure("invalid-data", input);
  }
  if (startSeconds < 0 || endSeconds <= startSeconds) {
    return decodeFailure("invalid-data", input);
  }
  if (endSeconds - startSeconds > WORLD_CAPTURE_DYNAMIC_MAX_DURATION_SECONDS) {
    return decodeFailure("duration-exceeded", input);
  }
  return { ok: true, value: { startSeconds, endSeconds } };
}

export function decodeWorldCaptureDynamicOutput(
  input: unknown
): WorldCaptureDynamicDecodeResult<WorldCaptureDynamicOutput> {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, OUTPUT_KEYS)) {
    return decodeFailure("invalid-data", input);
  }
  const outputVersion = ownField(input, "outputVersion");
  const width = ownField(input, "width");
  const height = ownField(input, "height");
  const container = ownField(input, "container");
  if (!isNonEmptyWorldId(outputVersion) || !isPositiveSafeInteger(width) || !isPositiveSafeInteger(height)) {
    return decodeFailure("invalid-data", input);
  }
  if (container !== WORLD_CAPTURE_DYNAMIC_CONTAINER) {
    return decodeFailure("unsupported-container", input);
  }
  return { ok: true, value: { outputVersion, width, height, container } };
}

/** 严格解码动态版本键；未知字段、非法区间、越界 fps 与未知容器整体拒绝。 */
export function decodeWorldCaptureDynamicVersionKey(
  input: unknown
): WorldCaptureDynamicDecodeResult<WorldCaptureDynamicVersionKey> {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, KEY_KEYS)) {
    return decodeFailure("invalid-data", input);
  }
  const base = decodeWorldCaptureVersionKey({
    canvasId: ownField(input, "canvasId"),
    cameraId: ownField(input, "cameraId"),
    worldContentVersion: ownField(input, "worldContentVersion"),
    cameraSettingsVersion: ownField(input, "cameraSettingsVersion"),
    bindingVersion: ownField(input, "bindingVersion"),
    outputVersion: ownField(input, "outputVersion")
  });
  if (!base.ok) return decodeFailure(base.code, input);
  const animation = decodeWorldCaptureAnimationVersion(ownField(input, "animation"));
  if (!animation.ok) return decodeFailure(animation.code, input);
  const timeRange = decodeWorldCaptureTimeRange(ownField(input, "timeRange"));
  if (!timeRange.ok) return decodeFailure(timeRange.code, input);
  if (timeRange.value.endSeconds > animation.value.durationSeconds + 1e-9) {
    return decodeFailure("invalid-data", input);
  }
  const fps = ownField(input, "fps");
  if (!isFps(fps)) return decodeFailure("fps-out-of-range", input);
  return {
    ok: true,
    value: {
      canvasId: base.value.canvasId,
      cameraId: base.value.cameraId,
      worldContentVersion: base.value.worldContentVersion,
      cameraSettingsVersion: base.value.cameraSettingsVersion,
      bindingVersion: base.value.bindingVersion,
      outputVersion: base.value.outputVersion,
      animation: animation.value,
      timeRange: timeRange.value,
      fps
    }
  };
}

/** 基础六字段键（既有 `WorldCaptureVersionKey`）；`outputVersion` 已覆盖动态规格。 */
export function worldCaptureDynamicBaseKey(key: WorldCaptureDynamicVersionKey): WorldCaptureVersionKey {
  return {
    canvasId: key.canvasId,
    cameraId: key.cameraId,
    worldContentVersion: key.worldContentVersion,
    cameraSettingsVersion: key.cameraSettingsVersion,
    bindingVersion: key.bindingVersion,
    outputVersion: key.outputVersion
  };
}

/** 稳定签名：既用于等价比较，也用于派生稳定的请求身份。 */
export function worldCaptureDynamicVersionSignature(key: WorldCaptureDynamicVersionKey): string {
  const decoded = decodeWorldCaptureDynamicVersionKey(key);
  if (!decoded.ok) throw codecFailureError(decoded.code, "动态取景版本键");
  const value = decoded.value;
  return JSON.stringify([
    value.canvasId,
    value.cameraId,
    value.worldContentVersion,
    value.cameraSettingsVersion,
    value.bindingVersion,
    value.outputVersion,
    value.animation.areaId,
    value.animation.scriptRevision,
    value.animation.sourceHash,
    value.animation.durationSeconds,
    value.timeRange.startSeconds,
    value.timeRange.endSeconds,
    value.fps
  ]);
}

/** 完整动态键相等；非法值一律不相等。 */
export function worldCaptureDynamicKeysEqual(
  left: WorldCaptureDynamicVersionKey,
  right: WorldCaptureDynamicVersionKey
): boolean {
  const a = decodeWorldCaptureDynamicVersionKey(left);
  const b = decodeWorldCaptureDynamicVersionKey(right);
  if (!a.ok || !b.ok) return false;
  return worldCaptureDynamicVersionSignature(a.value) === worldCaptureDynamicVersionSignature(b.value);
}

/** 稳定的动态请求身份：同一冻结键的重试永远得到同一个 requestId。 */
export function worldCaptureDynamicRequestIdentity(key: WorldCaptureDynamicVersionKey): string {
  return `world-capture-dynamic:${worldCaptureDynamicVersionSignature(key)}`;
}

export type WorldCaptureDynamicReusePlan = {
  /** 本次请求 identity；与缓存相同才允许复用。 */
  readonly requestId: WorldId;
  readonly reuseBytes: boolean;
  /** 复用的媒体 id；`reuseBytes === false` 时为 null。 */
  readonly mediaId: WorldId | null;
};

/**
 * 幂等计划：只有 identity 完全相同才复用已上传字节和同一媒体登记；
 * 任何动画/区间/fps/镜头/世界版本变化都产生新 identity。
 */
export function planWorldCaptureDynamicAttempt(input: {
  key: WorldCaptureDynamicVersionKey;
  existing?: { readonly identity: string; readonly mediaId: WorldId } | null;
}): WorldCaptureDynamicReusePlan {
  const requestId = worldCaptureDynamicRequestIdentity(input.key);
  const existing = input.existing;
  if (existing && existing.identity === requestId && existing.mediaId.trim() !== "") {
    return { requestId, reuseBytes: true, mediaId: existing.mediaId };
  }
  return { requestId, reuseBytes: false, mediaId: null };
}

/** 严格解码视频媒体元数据；图片元数据或缺少 duration/fps 一律拒绝。 */
export function decodeWorldCaptureVideoMediaMetadata(
  input: unknown
): WorldCaptureDynamicDecodeResult<WorldCaptureVideoMediaMetadata> {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, VIDEO_MEDIA_KEYS)) {
    return decodeFailure("invalid-data", input);
  }
  if (ownField(input, "version") !== WORLD_CAPTURE_VIDEO_MEDIA_VERSION) {
    return decodeFailure("unsupported-version", input);
  }
  const mediaId = ownField(input, "mediaId");
  const storageKey = ownField(input, "storageKey");
  const checksum = ownField(input, "checksum");
  const size = ownField(input, "size");
  const contentType = ownField(input, "contentType");
  const width = ownField(input, "width");
  const height = ownField(input, "height");
  const container = ownField(input, "container");
  const durationSeconds = ownField(input, "durationSeconds");
  const fps = ownField(input, "fps");
  if (
    !isNonEmptyWorldId(mediaId) ||
    typeof storageKey !== "string" ||
    storageKey.trim() === "" ||
    typeof checksum !== "string" ||
    !CHECKSUM_PATTERN.test(checksum) ||
    !isPositiveSafeInteger(size) ||
    typeof contentType !== "string" ||
    !VIDEO_CONTENT_TYPE_PATTERN.test(contentType) ||
    !isPositiveSafeInteger(width) ||
    !isPositiveSafeInteger(height) ||
    container !== WORLD_CAPTURE_DYNAMIC_CONTAINER ||
    !isFiniteNumber(durationSeconds) ||
    durationSeconds <= 0 ||
    !isFps(fps)
  ) {
    return decodeFailure("invalid-data", input);
  }
  return {
    ok: true,
    value: {
      version: WORLD_CAPTURE_VIDEO_MEDIA_VERSION,
      mediaId,
      storageKey,
      checksum,
      size,
      contentType,
      width,
      height,
      container,
      durationSeconds,
      fps
    }
  };
}

export function encodeWorldCaptureVideoMediaMetadata(value: WorldCaptureVideoMediaMetadata): unknown {
  const decoded = decodeWorldCaptureVideoMediaMetadata(value);
  if (!decoded.ok) throw codecFailureError(decoded.code, "视频媒体元数据");
  return decoded.value;
}

export function decodeWorldCaptureVideo(input: unknown): WorldCaptureVideo | null {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, VIDEO_KEYS)) return null;
  const bytes = ownField(input, "bytes");
  const contentType = ownField(input, "contentType");
  const width = ownField(input, "width");
  const height = ownField(input, "height");
  const durationSeconds = ownField(input, "durationSeconds");
  const fps = ownField(input, "fps");
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return null;
  if (contentType !== WORLD_CAPTURE_DYNAMIC_CONTAINER) return null;
  if (!isPositiveSafeInteger(width) || !isPositiveSafeInteger(height)) return null;
  if (!isFiniteNumber(durationSeconds) || durationSeconds <= 0) return null;
  if (!isFps(fps)) return null;
  return {
    bytes: new Uint8Array(bytes),
    contentType: WORLD_CAPTURE_DYNAMIC_CONTAINER,
    width,
    height,
    durationSeconds,
    fps
  };
}

function subjectContents(subject: WorldCaptureDynamicSubject): readonly WorldCaptureInstanceContent[] {
  switch (subject.kind) {
    case "world":
      return subject.contents;
    case "instance":
      return [{ instanceId: subject.instanceId, content: subject.content }];
    case "bound-missing":
      return [];
  }
}

function decodeSubject(input: unknown, camera: WorldCameraData): WorldCaptureDynamicDecodeResult<WorldCaptureDynamicSubject> {
  if (!isJsonRecord(input)) return decodeFailure("invalid-data", input);
  const kind = ownField(input, "kind");
  if (kind === "world") {
    if (camera.boundInstanceId !== null) return decodeFailure("invalid-data", input);
    if (!hasOnlyKeys(input, ["kind", "instances", "contents"])) return decodeFailure("invalid-data", input);
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
    const ids = new Set(contents.value.map(content => content.instanceId));
    if (ids.size !== instances.length || instances.some(instance => !ids.has(instance.instanceId))) {
      return decodeFailure("invalid-data", input);
    }
    return { ok: true, value: { kind: "world", instances, contents: contents.value } };
  }
  if (kind === "instance") {
    if (!hasOnlyKeys(input, ["kind", "instanceId", "instance", "content"])) return decodeFailure("invalid-data", input);
    const instanceId = ownField(input, "instanceId");
    if (!isNonEmptyWorldId(instanceId) || camera.boundInstanceId !== instanceId) {
      return decodeFailure("invalid-data", input);
    }
    const instance = decodeWorldInstanceData(ownField(input, "instance"));
    if (!instance.ok || instance.value.instanceId !== instanceId) return decodeFailure("invalid-data", input);
    const content = createWorldCaptureModelContent(ownField(input, "content"));
    if (!content.ok) return decodeFailure(content.code, input);
    return { ok: true, value: { kind: "instance", instanceId, instance: instance.value, content: content.value } };
  }
  if (kind === "bound-missing") {
    if (!hasOnlyKeys(input, ["kind", "instanceId"])) return decodeFailure("invalid-data", input);
    const instanceId = ownField(input, "instanceId");
    if (!isNonEmptyWorldId(instanceId) || camera.boundInstanceId !== instanceId) {
      return decodeFailure("invalid-data", input);
    }
    return { ok: true, value: { kind: "bound-missing", instanceId } };
  }
  return decodeFailure("invalid-data", input);
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

function decodeWorldCaptureDynamicRequest(input: unknown): WorldCaptureDynamicDecodeResult<WorldCaptureDynamicRequest> {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, REQUEST_KEYS)) {
    return decodeFailure("invalid-data", input);
  }
  if (ownField(input, "version") !== WORLD_CAPTURE_DYNAMIC_REQUEST_VERSION) {
    return decodeFailure("unsupported-version", input);
  }
  const requestId = ownField(input, "requestId");
  if (!isNonEmptyWorldId(requestId)) return decodeFailure("invalid-data", input);
  const key = decodeWorldCaptureDynamicVersionKey(ownField(input, "key"));
  if (!key.ok) return decodeFailure(key.code, input);
  const camera = decodeWorldCamera(ownField(input, "camera"));
  if (!camera.ok) return decodeFailure(camera.code, input);
  if (
    camera.value.cameraId !== key.value.cameraId ||
    camera.value.settingsVersion !== key.value.cameraSettingsVersion
  ) {
    return decodeFailure("invalid-data", input);
  }
  const output = decodeWorldCaptureDynamicOutput(ownField(input, "output"));
  if (!output.ok) return decodeFailure(output.code, input);
  if (
    output.value.outputVersion !== key.value.outputVersion ||
    output.value.outputVersion !== worldCaptureDynamicBaseKey(key.value).outputVersion
  ) {
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
      version: WORLD_CAPTURE_DYNAMIC_REQUEST_VERSION,
      requestId,
      key: key.value,
      camera: camera.value,
      subject: subject.value,
      output: output.value,
      contentFingerprint
    })
  };
}

/** 构建不可变动态取景请求；失败时保留调用方输入。 */
export function createWorldCaptureDynamicRequest(
  input: unknown
): WorldCaptureDynamicDecodeResult<WorldCaptureDynamicRequest> {
  return decodeWorldCaptureDynamicRequest(input);
}

export function encodeWorldCaptureDynamicVersionKey(key: WorldCaptureDynamicVersionKey): unknown {
  const decoded = decodeWorldCaptureDynamicVersionKey(key);
  if (!decoded.ok) throw codecFailureError(decoded.code, "动态取景版本键");
  return decoded.value;
}

/**
 * 冻结：只有结果键等于当前键才发布 ready。返回值保持既有 `WorldCaptureInput` 形状。
 */
export function freezeWorldCaptureVideoInput(
  requestKey: WorldCaptureDynamicVersionKey,
  currentKey: WorldCaptureDynamicVersionKey,
  media: WorldCaptureVideoMediaMetadata
): { readonly ok: true; readonly value: WorldCaptureVideoFrozenInput } | { readonly ok: false; readonly code: "superseded" | "media-unverified" } {
  if (!worldCaptureDynamicKeysEqual(requestKey, currentKey)) return { ok: false, code: "superseded" };
  const decoded = decodeWorldCaptureVideoMediaMetadata(media);
  if (!decoded.ok) return { ok: false, code: "media-unverified" };
  const value = decoded.value;
  if (
    value.width <= 0 ||
    value.height <= 0 ||
    Math.abs(value.durationSeconds - (requestKey.timeRange.endSeconds - requestKey.timeRange.startSeconds)) > 0.25 ||
    value.fps !== requestKey.fps
  ) {
    return { ok: false, code: "media-unverified" };
  }
  const key = worldCaptureDynamicBaseKey(requestKey);
  return {
    ok: true,
    value: {
      version: "world-capture-video-input-v1",
      key,
      input: { key, mediaId: value.mediaId, checksum: value.checksum },
      media: value
    }
  };
}

/** 判定一个动态生产者结果是否属于该请求。 */
function outcomeMatches(
  request: WorldCaptureDynamicRequest,
  outcome: WorldCaptureDynamicProducerOutcome
): boolean {
  return (
    outcome.requestId === request.requestId &&
    worldCaptureDynamicKeysEqual(outcome.key, request.key) &&
    outcome.contentFingerprint === request.contentFingerprint
  );
}

/**
 * 解析一次动态结果；顺序与静态一致：取消优先，其次版本替换，最后校验身份与媒体。
 * 迟到/旧版本结果永远不能变成 ready。
 */
export function resolveWorldCaptureDynamicOutcome(input: {
  request: WorldCaptureDynamicRequest;
  currentKey: WorldCaptureDynamicVersionKey;
  cancelled: boolean;
  outcome: WorldCaptureDynamicProducerOutcome;
  saved?: WorldCaptureDynamicSaveResult;
}): WorldCaptureDynamicResolution {
  const decodedRequest = decodeWorldCaptureDynamicRequest(input.request);
  if (!decodedRequest.ok) throw codecFailureError(decodedRequest.code, "动态取景请求");
  const request = decodedRequest.value;
  const current = decodeWorldCaptureDynamicVersionKey(input.currentKey);
  if (!current.ok) throw codecFailureError(current.code, "动态取景当前版本");

  if (input.cancelled) {
    return { status: "cancelled", requestId: request.requestId, key: request.key };
  }
  if (!worldCaptureDynamicKeysEqual(request.key, current.value)) {
    return {
      status: "superseded",
      requestId: request.requestId,
      requestedKey: request.key,
      currentKey: current.value
    };
  }
  if (!outcomeMatches(request, input.outcome)) {
    return { status: "rejected", requestId: request.requestId, key: request.key, code: "request-mismatch" };
  }

  const outcome = input.outcome;
  switch (outcome.status) {
    case "cancelled":
      return { status: "cancelled", requestId: request.requestId, key: request.key };
    case "waiting":
      return request.subject.kind === "bound-missing"
        ? { status: "unavailable", requestId: request.requestId, key: request.key, reason: "bound-target-missing" }
        : { status: "waiting", requestId: request.requestId, key: request.key, reason: outcome.reason };
    case "unavailable":
      return { status: "unavailable", requestId: request.requestId, key: request.key, reason: outcome.reason };
    case "failed":
      return { status: "failed", requestId: request.requestId, key: request.key, code: outcome.code };
    case "video": {
      if (request.subject.kind === "bound-missing") {
        return { status: "rejected", requestId: request.requestId, key: request.key, code: "invalid-video" };
      }
      const video = decodeWorldCaptureVideo(outcome.video);
      if (
        !video ||
        video.width !== request.output.width ||
        video.height !== request.output.height ||
        Math.abs(video.durationSeconds - (request.key.timeRange.endSeconds - request.key.timeRange.startSeconds)) > 0.25 ||
        video.fps !== request.key.fps
      ) {
        return { status: "rejected", requestId: request.requestId, key: request.key, code: "invalid-video" };
      }
      if (!input.saved) {
        return { status: "media-required", requestId: request.requestId, key: request.key, video };
      }
      const saved = input.saved;
      const sameIdentity =
        saved.requestId === request.requestId &&
        worldCaptureDynamicKeysEqual(saved.key, request.key) &&
        saved.contentFingerprint === request.contentFingerprint;
      if (!sameIdentity) {
        return { status: "rejected", requestId: request.requestId, key: request.key, code: "media-unverified" };
      }
      if (saved.status === "cancelled") {
        return { status: "cancelled", requestId: request.requestId, key: request.key };
      }
      if (saved.status === "failed") {
        return {
          status: "failed",
          requestId: request.requestId,
          key: request.key,
          code: saved.code ?? "media-save-failed"
        };
      }
      const media = decodeWorldCaptureVideoMediaMetadata(saved.media);
      if (
        !media.ok ||
        media.value.size !== video.bytes.length ||
        media.value.contentType !== video.contentType ||
        media.value.width !== video.width ||
        media.value.height !== video.height ||
        Math.abs(media.value.durationSeconds - video.durationSeconds) > 0.25 ||
        media.value.fps !== video.fps
      ) {
        return { status: "rejected", requestId: request.requestId, key: request.key, code: "media-unverified" };
      }
      const frozen = freezeWorldCaptureVideoInput(request.key, current.value, media.value);
      if (!frozen.ok) {
        return {
          status: frozen.code === "superseded" ? "superseded" : "rejected",
          requestId: request.requestId,
          key: request.key,
          ...(frozen.code === "superseded"
            ? { requestedKey: request.key, currentKey: current.value }
            : { code: "media-unverified" })
        } as WorldCaptureDynamicResolution;
      }
      return { status: "ready", requestId: request.requestId, key: request.key, frozen: frozen.value };
    }
  }
}

/** 构建视频保存请求；视频尺寸/时长/fps 必须与请求输出一致。 */
export function createWorldCaptureDynamicMediaSaveRequest(
  request: WorldCaptureDynamicRequest,
  video: WorldCaptureVideo
): { readonly ok: true; readonly value: WorldCaptureDynamicMediaSaveRequest } | { readonly ok: false; readonly code: "invalid-video" } {
  const decodedRequest = decodeWorldCaptureDynamicRequest(request);
  if (!decodedRequest.ok) throw codecFailureError(decodedRequest.code, "动态取景请求");
  const decodedVideo = decodeWorldCaptureVideo(video);
  if (
    !decodedVideo ||
    request.subject.kind === "bound-missing" ||
    decodedVideo.width !== request.output.width ||
    decodedVideo.height !== request.output.height ||
    decodedVideo.fps !== request.key.fps ||
    Math.abs(decodedVideo.durationSeconds - (request.key.timeRange.endSeconds - request.key.timeRange.startSeconds)) > 0.25
  ) {
    return { ok: false, code: "invalid-video" };
  }
  return {
    ok: true,
    value: {
      requestId: request.requestId,
      key: request.key,
      contentFingerprint: request.contentFingerprint,
      video: decodedVideo
    }
  };
}

/** 动态取景的内容解析输入（与静态契约同形，供生产者按冻结内容取资源）。 */
export function createWorldCaptureDynamicContentResolutionRequest(request: WorldCaptureDynamicRequest): {
  readonly requestId: WorldId;
  readonly contentFingerprint: string;
  readonly instances: readonly WorldCaptureInstanceContent[];
} {
  const decoded = decodeWorldCaptureDynamicRequest(request);
  if (!decoded.ok) throw codecFailureError(decoded.code, "动态取景请求");
  return deepFreeze({
    requestId: decoded.value.requestId,
    contentFingerprint: decoded.value.contentFingerprint,
    instances: subjectContents(decoded.value.subject)
  });
}

/** 从完整请求派生基础六字段键（供生成绑定与下游任务输入复用）。 */
export function worldCaptureDynamicRequestBaseKey(request: WorldCaptureDynamicRequest): WorldCaptureVersionKey {
  return worldCaptureDynamicBaseKey(request.key);
}

/** 便捷判断：动态媒体确实属于该冻结键（避免旧图片或旧区间结果混入视频链路）。 */
export function videoMediaBelongsToKey(
  key: WorldCaptureDynamicVersionKey,
  media: WorldCaptureVideoMediaMetadata
): boolean {
  const decodedKey = decodeWorldCaptureDynamicVersionKey(key);
  if (!decodedKey.ok) return false;
  const decodedMedia = decodeWorldCaptureVideoMediaMetadata(media);
  if (!decodedMedia.ok) return false;
  return (
    decodedMedia.value.fps === decodedKey.value.fps &&
    Math.abs(
      decodedMedia.value.durationSeconds -
        (decodedKey.value.timeRange.endSeconds - decodedKey.value.timeRange.startSeconds)
    ) <= 0.25
  );
}

/** 只用于测试/诊断：动态取景是否覆盖了某个镜头。 */
export function dynamicRequestTargetsCamera(request: WorldCaptureDynamicRequest, cameraId: WorldId): boolean {
  return request.key.cameraId === cameraId;
}

/** 未使用的画布参数占位，保证调用方显式传入当前画布（避免误用旧快照）。 */
export type WorldCaptureDynamicCanvasRef = Pick<ServerCanvas, "id">;
