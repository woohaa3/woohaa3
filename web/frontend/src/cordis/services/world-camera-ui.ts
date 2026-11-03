/**
 * Browser-side camera settings UI service.
 *
 * Owns the transport-facing half of the camera panel: it calls the existing
 * authoritative `world-camera-save` / `world-camera-restore` / `world-camera-history`
 * ports, validates that each receipt still describes the requested canvas and camera,
 * and waits for the canonical Yjs projection to adopt a successful write before the
 * panel invites another save. It never creates completion history, never synthesizes
 * capture media and never rewrites a missing binding.
 */
import {
  decodeWorldCamera,
  worldCameraFailureText,
  type ServerCanvas,
  type WorldAuthoringConflict,
  type WorldCameraData,
  type WorldCameraHistoryEntry,
  type WorldCameraHistoryListInput,
  type WorldCameraRestoreInput,
  type WorldCameraSettingsSaveInput
} from "@woohaa3/contracts";
import type { CanvasRemoteService } from "../contracts.js";

export type WorldCameraUiFailure = {
  ok: false;
  code: string;
  message: string;
  conflicts?: WorldAuthoringConflict[];
};
export type WorldCameraSaveResult =
  | {
      ok: true;
      camera: WorldCameraData;
      settingsVersion: string;
      revision: number;
      duplicate: boolean;
    }
  | WorldCameraUiFailure;
export type WorldCameraHistoryResult =
  | { ok: true; entries: WorldCameraHistoryEntry[] }
  | WorldCameraUiFailure;
export type WorldCameraRestoreResult =
  | {
      ok: true;
      camera: WorldCameraData;
      settingsVersion: string;
      revision: number;
      duplicate: boolean;
      history: WorldCameraHistoryEntry;
    }
  | WorldCameraUiFailure;

/** Decode the camera attached to one canvas node; `null` when absent or invalid. */
export function readWorldCamera(canvas: ServerCanvas | null | undefined, nodeId: string | null): WorldCameraData | null {
  if (!canvas || !nodeId) return null;
  const data = canvas.nodeData[nodeId];
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const decoded = decodeWorldCamera((data as Record<string, unknown>).worldCamera);
  return decoded.ok ? decoded.value : null;
}

export async function submitWorldCameraSave(
  remote: Pick<CanvasRemoteService, "saveWorldCamera">,
  input: WorldCameraSettingsSaveInput,
  signal?: AbortSignal
): Promise<WorldCameraSaveResult> {
  let outcome: Awaited<ReturnType<CanvasRemoteService["saveWorldCamera"]>>;
  try {
    outcome = await remote.saveWorldCamera(input, signal);
  } catch (error) {
    return failure(signal?.aborted ? "cancelled" : "not-ready",
      signal?.aborted ? "保存已取消" : error instanceof Error ? error.message : "镜头保存失败");
  }
  if (!outcome.ok) return failure(outcome.code, outcome.message, outcome.conflicts);
  if (outcome.canvasId !== input.canvasId || outcome.cameraId !== input.cameraId) {
    return failure("invalid-data", "镜头保存回执的画布或镜头不一致");
  }
  const decoded = decodeWorldCamera(outcome.camera);
  if (!decoded.ok || decoded.value.cameraId !== input.cameraId || decoded.value.settingsVersion !== outcome.settingsVersion) {
    return failure("invalid-data", "镜头保存回执无效");
  }
  return {
    ok: true,
    camera: decoded.value,
    settingsVersion: outcome.settingsVersion,
    revision: outcome.revision,
    duplicate: outcome.duplicate
  };
}

export async function loadWorldCameraHistory(
  remote: Pick<CanvasRemoteService, "listWorldCameraHistory">,
  input: WorldCameraHistoryListInput,
  signal?: AbortSignal
): Promise<WorldCameraHistoryResult> {
  let outcome: Awaited<ReturnType<CanvasRemoteService["listWorldCameraHistory"]>>;
  try {
    outcome = await remote.listWorldCameraHistory(input, signal);
  } catch (error) {
    return failure(signal?.aborted ? "cancelled" : "not-ready",
      signal?.aborted ? "已取消读取镜头历史" : error instanceof Error ? error.message : "无法读取镜头历史");
  }
  if (!outcome.ok) return failure(outcome.code, outcome.message, outcome.conflicts);
  if (outcome.canvasId !== input.canvasId || outcome.cameraId !== input.cameraId
    || !Array.isArray(outcome.entries)
    || outcome.entries.some((entry) => entry.cameraId !== input.cameraId || entry.canvasId !== input.canvasId)) {
    return failure("invalid-data", "镜头历史回执与当前镜头不一致");
  }
  return { ok: true, entries: [...outcome.entries] };
}

export async function submitWorldCameraRestore(
  remote: Pick<CanvasRemoteService, "restoreWorldCamera">,
  input: WorldCameraRestoreInput,
  signal?: AbortSignal
): Promise<WorldCameraRestoreResult> {
  let outcome: Awaited<ReturnType<CanvasRemoteService["restoreWorldCamera"]>>;
  try {
    outcome = await remote.restoreWorldCamera(input, signal);
  } catch (error) {
    return failure(signal?.aborted ? "cancelled" : "not-ready",
      signal?.aborted ? "恢复已取消" : error instanceof Error ? error.message : "镜头恢复失败");
  }
  if (!outcome.ok) return failure(outcome.code, outcome.message, outcome.conflicts);
  if (outcome.canvasId !== input.canvasId || outcome.cameraId !== input.cameraId) {
    return failure("invalid-data", "镜头恢复回执的画布或镜头不一致");
  }
  const decoded = decodeWorldCamera(outcome.camera);
  if (!decoded.ok || decoded.value.cameraId !== input.cameraId || decoded.value.settingsVersion !== outcome.settingsVersion) {
    return failure("invalid-data", "镜头恢复回执无效");
  }
  if (outcome.history.completionKey !== input.completionKey || outcome.history.cameraId !== input.cameraId) {
    return failure("invalid-data", "镜头恢复没有对应到请求的历史版本");
  }
  return {
    ok: true,
    camera: decoded.value,
    settingsVersion: outcome.settingsVersion,
    revision: outcome.revision,
    duplicate: outcome.duplicate,
    history: outcome.history
  };
}

/**
 * Wait until the canonical projection carries the just-written settings version at or
 * past the receipt revision. A timeout is reported to the caller; it is not treated as
 * a failed save, because the authority already committed the durable write.
 */
export async function awaitWorldCameraCanonical(input: {
  readCanvas: () => ServerCanvas | null;
  canvasId: string;
  nodeId: string;
  cameraId: string;
  settingsVersion: string;
  revision: number;
  signal?: AbortSignal;
  attempts?: number;
  wait?: () => Promise<void>;
}): Promise<boolean> {
  const attempts = input.attempts ?? 40;
  const wait = input.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (input.signal?.aborted) return false;
    const canvas = input.readCanvas();
    if (canvas && canvas.id === input.canvasId && canvas.revision >= input.revision) {
      const camera = readWorldCamera(canvas, input.nodeId);
      if (camera && camera.cameraId === input.cameraId && camera.settingsVersion === input.settingsVersion) return true;
    }
    await wait();
  }
  return false;
}

export function worldCameraUiFailureText(failure: WorldCameraUiFailure): string {
  return worldCameraFailureText(failure.code, failure.message);
}

function failure(code: string, message: string, conflicts?: WorldAuthoringConflict[]): WorldCameraUiFailure {
  return { ok: false, code, message, ...(conflicts ? { conflicts } : {}) };
}
