/**
 * Public and internal state shapes for the T10 capture scheduler.
 */
import type {
  WorldCaptureFramingStatus,
  WorldCaptureGenerationBinding,
  WorldCaptureMediaSavePort,
  WorldCaptureProducer,
  WorldCaptureProducerRegistration,
  WorldCaptureRefreshOutcome,
  WorldCaptureVersionKey
} from "@woohaa3/contracts";

export const DEFAULT_FREEZE_TIMEOUT_MS = 15_000;
export const DEFAULT_CLAIM_TTL_MS = 10 * 60_000;

export type WorldCaptureServiceOptions = {
  resolveRoom(canvasId: string): Promise<import("../sync/room.js").CanvasRoom | null>;
  /** Trusted save port (host injects the media service adapter). Missing means fail closed. */
  mediaSave?: WorldCaptureMediaSavePort;
  /** Static capture long edge in pixels; host configuration, never a browser claim. */
  outputLongEdge?: number;
  /** How long generation acceptance may wait for one exact key. */
  freezeTimeoutMs?: number;
  /** Frozen binding claim lifetime. */
  claimTtlMs?: number;
  now?: () => number;
  logger?: (event: Record<string, unknown>) => void;
};

export type WorldCaptureClaimInput = {
  canvasId: string;
  requestId: string;
  binding: WorldCaptureGenerationBinding;
};

export type WorldCaptureClaimResult =
  | { ok: true; binding: WorldCaptureGenerationBinding }
  | { ok: false; code: "unknown-capture" | "capture-expired" | "capture-mismatch"; message: string };

export type WorldCaptureService = {
  registerProducer(producer: WorldCaptureProducer): WorldCaptureProducerRegistration;
  notifyResourcesReady(notice: import("@woohaa3/contracts").WorldCaptureResourceReadyNotice): void;
  /** Observe a committed canonical snapshot; only a changed authoring key starts work. */
  observeCanonical(input: { canvasId: string; canvas: import("@woohaa3/contracts").ServerCanvas }): void;
  refresh(input: { canvasId: string; cameraId: string }): Promise<WorldCaptureRefreshOutcome>;
  status(input: { canvasId: string; cameraId: string }): WorldCaptureFramingStatus;
  freezeForGeneration(input: {
    canvasId: string;
    cameraId: string;
    requestId?: string;
    signal?: AbortSignal;
  }): Promise<import("@woohaa3/contracts").WorldCaptureFreezeOutcome>;
  /** Validate a completed freeze immediately before durable run acceptance. */
  claimForGeneration(input: WorldCaptureClaimInput): WorldCaptureClaimResult;
  forgetCanvas(canvasId: string): void;
  dispose(): void;
};

export type Attempt = {
  attemptId: number;
  requestId: string;
  key: WorldCaptureVersionKey;
  controller: AbortController;
  promise: Promise<void>;
};

export type FramingState = {
  canvasId: string;
  cameraId: string;
  key: WorldCaptureVersionKey | null;
  phase: WorldCaptureFramingStatus["phase"];
  stale: boolean;
  frozen?: import("@woohaa3/contracts").WorldCaptureFrozenInput;
  lastRequestId?: string;
  lastContentFingerprint?: string;
  width?: number;
  height?: number;
  reason?: string;
  attempt?: Attempt;
  attemptCounter: number;
  observation?: import("./capture-snapshot.js").Observation;
};

export type Claim = {
  binding: WorldCaptureGenerationBinding;
  createdAt: number;
};

export function statusOf(state: FramingState): WorldCaptureFramingStatus {
  const frozen = state.frozen;
  return {
    canvasId: state.canvasId,
    cameraId: state.cameraId,
    key: state.key,
    phase: state.phase,
    stale: state.stale,
    ...(state.lastRequestId ? { requestId: state.lastRequestId } : {}),
    ...(state.lastContentFingerprint ? { contentFingerprint: state.lastContentFingerprint } : {}),
    ...(frozen ? { input: { key: frozen.key, mediaId: frozen.media.mediaId, checksum: frozen.media.checksum } } : {}),
    ...(state.width !== undefined ? { width: state.width } : {}),
    ...(state.height !== undefined ? { height: state.height } : {}),
    ...(state.reason ? { reason: state.reason } : {})
  };
}

export function emptyStatus(canvasId: string, cameraId: string): WorldCaptureFramingStatus {
  return { canvasId, cameraId, key: null, phase: "empty", stale: false };
}
