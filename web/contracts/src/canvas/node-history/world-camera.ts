/**
 * World-camera settings and assistant-completion history (T08).
 *
 * These DTOs are the transport/port surface for the authoritative camera settings
 * service. They deliberately contain no storage, command or version algorithm:
 *
 * - `WorldCameraSettings` is the user-editable part of a `worldCamera` payload.
 *   The camera identity and `settingsVersion` stay authority-owned.
 * - `WorldCameraHistoryEntry` stores exactly one assistant completion and its
 *   camera settings. The stable completion key is
 *   `JSON.stringify([canvasId, runId, completionId, cameraId])` (OC05a).
 * - Completion intake is host-internal: the port carries the frozen
 *   `WorldCompletion` plus opaque host evidence, never a client-asserted success.
 *
 * Card layout (node position/width/height) is never part of these values, so
 * rearranging camera cards cannot change framing.
 */
import type {
  WorldCameraCaptureMode,
  WorldCameraData,
  WorldCameraProjection,
  WorldCompletion,
  WorldId,
  WorldPoint,
  WorldRotation,
  WorldVersion
} from "../shared-world.js";
import type { WorldCameraHistorySnapshot } from "../world-camera-codec.js";
import type { WorldAuthoringConflict } from "../world-authoring.js";

/** User-editable camera settings; identity and version are assigned by the authority. */
export interface WorldCameraSettings {
  position: WorldPoint;
  rotation: WorldRotation;
  projection: WorldCameraProjection;
  captureMode: WorldCameraCaptureMode;
  aspect: { width: number; height: number };
  /** `null` is an explicit unbind. A missing bound target is never rewritten to null. */
  boundInstanceId: WorldId | null;
}

export type WorldCameraFailureCode =
  | "invalid-data"
  | "unsupported-version"
  | "not-ready"
  | "not-found"
  | "version-conflict"
  | "operation-conflict"
  | "lease-conflict"
  | "stale-epoch"
  | "outside-scope"
  | "target-unavailable"
  | "cancelled"
  | "write-forbidden";

export interface WorldCameraFailure {
  ok: false;
  code: WorldCameraFailureCode;
  message: string;
  conflicts?: WorldAuthoringConflict[];
}

export interface WorldCameraSettingsSaveInput {
  canvasId: WorldId;
  cameraId: WorldId;
  /** Canonical settings version observed at gesture start. */
  expectedSettingsVersion: WorldVersion;
  settings: WorldCameraSettings;
  /** Optional host-issued world tool context; required for assistant-scoped writes. */
  contextId?: WorldId;
  actorId?: string;
  operationId?: WorldId;
  /**
   * Optional frozen command payload hash. A caller that has already persisted a
   * durable write intent passes the hash it derived for the exact camera patch,
   * so an idempotent retry can only resolve the same command identity and never
   * silently accept a different payload.
   */
  expectedPayloadHash?: string;
}

export type WorldCameraSettingsSaveOutcome =
  | {
      ok: true;
      canvasId: WorldId;
      cameraId: WorldId;
      commandId: string;
      revision: number;
      duplicate: boolean;
      camera: WorldCameraData;
      settingsVersion: WorldVersion;
    }
  | WorldCameraFailure;

/** Restore one assistant completion using the current world and current models. */
export interface WorldCameraRestoreInput {
  canvasId: WorldId;
  cameraId: WorldId;
  completionKey: string;
  /** Canonical settings version observed at gesture start. */
  expectedSettingsVersion: WorldVersion;
  contextId?: WorldId;
  actorId?: string;
}

export type WorldCameraRestoreOutcome =
  | (Extract<WorldCameraSettingsSaveOutcome, { ok: true }> & {
      /** The history entry that supplied the restored settings. */
      history: WorldCameraHistoryEntry;
    })
  | WorldCameraFailure;

/** Durable assistant-completion history entry. */
export interface WorldCameraHistoryEntry {
  completionKey: string;
  canvasId: WorldId;
  cameraId: WorldId;
  runId: WorldId;
  completionId: WorldId;
  settingsVersion: WorldVersion;
  createdAt: string;
  snapshot: WorldCameraHistorySnapshot;
}

export interface WorldCameraHistoryListInput {
  canvasId: WorldId;
  cameraId: WorldId;
  limit?: number;
}

export type WorldCameraHistoryListOutcome =
  | { ok: true; canvasId: WorldId; cameraId: WorldId; entries: WorldCameraHistoryEntry[] }
  | WorldCameraFailure;

/** Host-internal completion intake; `evidence` is never accepted from a public route. */
export interface WorldCameraCompletionIntake {
  completion: WorldCompletion;
  evidence?: unknown;
}

export type WorldCameraCompletionOutcome =
  | { ok: true; duplicate: boolean; entry: WorldCameraHistoryEntry }
  | WorldCameraFailure;

/** Transport-neutral port implemented by the canvas service. */
export type BackendWorldCameraPort = {
  save(
    input: WorldCameraSettingsSaveInput,
    options?: { authorize?: () => Promise<boolean>; signal?: AbortSignal }
  ): Promise<WorldCameraSettingsSaveOutcome>;
  restore(
    input: WorldCameraRestoreInput,
    options?: { authorize?: () => Promise<boolean>; signal?: AbortSignal }
  ): Promise<WorldCameraRestoreOutcome>;
  history(input: WorldCameraHistoryListInput): Promise<WorldCameraHistoryListOutcome>;
};
