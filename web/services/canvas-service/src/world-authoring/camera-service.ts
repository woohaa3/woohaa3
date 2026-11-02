/**
 * Authoritative world-camera settings service (T08).
 *
 * Responsibilities:
 *
 * - save the user-editable camera settings (pose, projection, capture mode,
 *   aspect, single binding) into the canonical `worldCamera` node payload;
 * - advance `settingsVersion` deterministically for every settings change and
 *   reject stale gesture-start versions;
 * - record one durable assistant-completion history row per stable OC05a key;
 * - restore a recorded completion against the *current* world and models while
 *   obeying the issued scope/epoch/lease and keeping one undoable command.
 *
 * The service never changes card position/size, never rewrites a missing binding
 * to `null`, and never creates history from capture refreshes or generations.
 */
import {
  SHARED_WORLD_VERSION,
  WORLD_CAMERA_HISTORY_VERSION,
  decodeWorldCamera,
  decodeWorldCameraHistorySnapshot,
  decodeWorldInstanceData,
  encodeWorldCameraHistorySnapshot,
  worldCameraCompletionKey,
  type BackendWorldCameraPort,
  type CanvasNodeData,
  type ServerCanvas,
  type WorldCameraData,
  type WorldCameraFailure,
  type WorldCameraFailureCode,
  type WorldCameraHistoryEntry,
  type WorldCameraHistoryListInput,
  type WorldCameraHistoryListOutcome,
  type WorldCameraRestoreInput,
  type WorldCameraRestoreOutcome,
  type WorldCameraSettings,
  type WorldCameraSettingsSaveInput,
  type WorldCameraSettingsSaveOutcome,
  type WorldCameraCompletionIntake,
  type WorldCameraCompletionOutcome,
  type WorldCompletion,
  type WorldToolContext
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts/canvas-yjs";
import type { CanvasRoom } from "../sync/room.js";
import type { RoomCommandResult } from "../sync/room-types.js";
import { nextCameraSettingsVersion, stableAuthorityVersion } from "./authority.js";
import type { WorldAuthoringFailure } from "@woohaa3/contracts";
import type { SpatialWriteContext } from "./spatial-leases.js";
import type { WorldCameraHistoryRepository } from "./camera-history.js";

/** Trusted frozen camera settings returned by the host completion verifier. */
export type WorldCameraCompletionTrust = { snapshot: WorldCameraData };

export type WorldCameraCompletionVerification = boolean | WorldCameraCompletionTrust | null;

export type WorldCameraCompletionVerifier = (
  completion: WorldCompletion,
  evidence: unknown
) => WorldCameraCompletionVerification | Promise<WorldCameraCompletionVerification>;

export type WorldCameraContextResolution =
  | { context: WorldToolContext; capability: SpatialWriteContext }
  | WorldAuthoringFailure;

export type WorldCameraSettingsServiceDeps = {
  resolveRoom(canvasId: string): Promise<CanvasRoom | null>;
  /** Host-internal resolution of an issued world tool context. */
  resolveContext(canvasId: string, contextId: string): WorldCameraContextResolution;
  history: WorldCameraHistoryRepository;
  /**
   * Trusted host completion verifier. Completion intake fails closed when this is
   * absent; a public HTTP body can never self-assert completion success.
   */
  verifyCompletion?: WorldCameraCompletionVerifier;
  now?: () => string;
};

export type WorldCameraSettingsService = BackendWorldCameraPort & {
  /** Host-internal assistant completion entry; never routed from untrusted HTTP. */
  complete(input: WorldCameraCompletionIntake, options?: { signal?: AbortSignal }): Promise<WorldCameraCompletionOutcome>;
};

type CameraNode = { nodeId: string; camera: WorldCameraData; fields: Record<string, unknown> };

const CAMERA_KEY = "worldCamera";

function failure(code: WorldCameraFailureCode, message: string, extra: Partial<WorldCameraFailure> = {}): WorldCameraFailure {
  return { ok: false, code, message, ...extra };
}

function authoringFailure(value: WorldAuthoringFailure): WorldCameraFailure {
  const code: WorldCameraFailureCode = value.code === "spatial-rejected" ? "outside-scope" : value.code;
  return failure(code, value.message, value.conflicts ? { conflicts: value.conflicts } : {});
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function findCamera(canvas: ServerCanvas, cameraId: string): CameraNode | null {
  for (const node of canvas.document.nodes) {
    const data = canvas.nodeData[node.id];
    if (!record(data)) continue;
    const decoded = decodeWorldCamera(data[CAMERA_KEY]);
    if (decoded.ok && decoded.value.cameraId === cameraId) {
      return { nodeId: node.id, camera: decoded.value, fields: data };
    }
  }
  return null;
}

function hasInstance(canvas: ServerCanvas, instanceId: string): boolean {
  for (const data of Object.values(canvas.nodeData)) {
    if (!record(data)) continue;
    const decoded = decodeWorldInstanceData(data.sharedWorldInstance);
    if (decoded.ok && decoded.value.instanceId === instanceId) return true;
  }
  return false;
}

/** Build and fully validate the next camera payload; `settingsVersion` is authority-owned. */
function nextCamera(cameraId: string, settings: WorldCameraSettings): WorldCameraData | WorldCameraFailure {
  const base: WorldCameraData = {
    kind: "world-camera",
    version: SHARED_WORLD_VERSION,
    cameraId,
    settingsVersion: "pending",
    position: settings.position,
    rotation: settings.rotation,
    projection: settings.projection,
    captureMode: settings.captureMode,
    aspect: settings.aspect,
    boundInstanceId: settings.boundInstanceId
  };
  const candidate: WorldCameraData = { ...base, settingsVersion: nextCameraSettingsVersion(base) };
  const decoded = decodeWorldCamera(candidate);
  if (!decoded.ok) {
    return failure("invalid-data", decoded.code === "unsupported-version" ? "不支持的镜头版本" : "镜头配置无效");
  }
  return decoded.value;
}

function mapLeaseErrorCode(code: string): WorldCameraFailureCode {
  switch (code) {
    case "lease-conflict": return "lease-conflict";
    case "outside-scope": return "outside-scope";
    case "stale-epoch": return "stale-epoch";
    case "request-conflict": return "operation-conflict";
    case "cancelled": return "cancelled";
    case "invalid-data":
    case "unavailable": return "not-ready";
    default: return "not-ready";
  }
}

function leaseFailure(error: unknown): WorldCameraFailure {
  const recordValue = error && typeof error === "object" ? error as { code?: unknown; conflict?: unknown } : {};
  const code = mapLeaseErrorCode(typeof recordValue.code === "string" ? recordValue.code : "");
  return failure(code, code === "lease-conflict" ? "目标正在被其他运行占用" : "无法取得镜头写占用");
}

function resultFailure(result: RoomCommandResult): WorldCameraFailure {
  if (result.ok) return failure("invalid-data", "unexpected");
  const domainCodes: WorldCameraFailureCode[] = [
    "invalid-data", "unsupported-version", "not-ready", "not-found", "version-conflict",
    "operation-conflict", "lease-conflict", "stale-epoch", "outside-scope", "target-unavailable",
    "cancelled", "write-forbidden"
  ];
  if (domainCodes.includes(result.code as WorldCameraFailureCode)) {
    return failure(result.code as WorldCameraFailureCode, result.message);
  }
  if (result.code === "spatial-rejected") {
    return failure("outside-scope", "空间写入资格无效", { ...(result.conflict ? { conflicts: [{
      target: result.conflict.target,
      version: null,
      runId: result.conflict.runId,
      epoch: result.conflict.epoch
    }] } : {}) });
  }
  if (result.code === "command-id-reused" || result.code === "request-id-reused") {
    return failure("operation-conflict", "相同操作身份使用了不同镜头配置");
  }
  if (result.code === "edit-precondition-failed") return failure("version-conflict", "镜头配置已变化");
  if (result.code === "write-forbidden") return failure("write-forbidden", "无权写入该画布");
  return failure("invalid-data", result.message);
}

function contextAllows(context: WorldToolContext, canvasId: string, cameraId: string, version: string): WorldCameraFailure | null {
  if (context.canvasId !== canvasId) return failure("stale-epoch", "工具上下文画布不一致");
  const entry = context.writableTargets.find(candidate =>
    candidate.target.kind === "camera" && candidate.target.cameraId === cameraId);
  if (!entry) {
    return failure(context.readOnlyReferences.some(candidate =>
      candidate.kind === "camera" && candidate.cameraId === cameraId)
      ? "outside-scope"
      : "outside-scope", "工具上下文未授予该镜头");
  }
  if (entry.target.version !== version) return failure("version-conflict", "镜头源版本或资格已变化");
  if (
    entry.lease.canvasId !== context.canvasId ||
    entry.lease.runId !== context.runId ||
    entry.lease.epoch !== context.epoch ||
    entry.lease.target.kind !== "camera" ||
    entry.lease.target.cameraId !== cameraId
  ) {
    return failure("stale-epoch", "镜头占用身份不一致");
  }
  return null;
}

function settingsOf(camera: WorldCameraData): WorldCameraSettings {
  return {
    position: camera.position,
    rotation: camera.rotation,
    projection: camera.projection,
    captureMode: camera.captureMode,
    aspect: camera.aspect,
    boundInstanceId: camera.boundInstanceId
  };
}

export function createWorldCameraSettingsService(
  deps: WorldCameraSettingsServiceDeps
): WorldCameraSettingsService {
  const now = deps.now ?? (() => new Date().toISOString());

  async function roomSnapshot(canvasId: string): Promise<{ ok: true; room: CanvasRoom; canvas: ServerCanvas } | WorldCameraFailure> {
    const room = await deps.resolveRoom(canvasId);
    if (!room) return failure("not-found", "画布不存在");
    const inspected = await room.inspectPublished(value => value);
    if (!inspected.ok) return failure("not-ready", inspected.message);
    return { ok: true, room, canvas: inspected.canvas };
  }

  async function applyCamera(
    input: WorldCameraSettingsSaveInput,
    options: { authorize?: () => Promise<boolean>; signal?: AbortSignal } | undefined,
    rule: { binding: "new" | "available"; tag: string }
  ): Promise<WorldCameraSettingsSaveOutcome> {
    if (!input || !nonEmpty(input.canvasId) || !nonEmpty(input.cameraId) || !nonEmpty(input.expectedSettingsVersion) || !record(input.settings)) {
      return failure("invalid-data", "镜头保存请求无效");
    }
    if (options?.signal?.aborted) return failure("cancelled", "保存已取消");

    let capability: SpatialWriteContext | undefined;
    if (input.contextId) {
      const resolved = deps.resolveContext(input.canvasId, input.contextId);
      if ("ok" in resolved) return authoringFailure(resolved);
      capability = resolved.capability;
    }

    const initial = await roomSnapshot(input.canvasId);
    if (!("room" in initial)) return initial;
    const initialCamera = findCamera(initial.canvas, input.cameraId);
    if (!initialCamera) return failure("not-found", "镜头不存在");
    if (initialCamera.camera.settingsVersion !== input.expectedSettingsVersion) {
      return failure("version-conflict", "镜头配置已变化");
    }
    if (capability && input.contextId) {
      const resolved = deps.resolveContext(input.canvasId, input.contextId);
      if ("ok" in resolved) return authoringFailure(resolved);
      const denied = contextAllows(resolved.context, input.canvasId, input.cameraId, input.expectedSettingsVersion);
      if (denied) return denied;
    }

    const operationId = nonEmpty(input.operationId)
      ? input.operationId
      : stableAuthorityVersion("world-camera-intent", {
          canvasId: input.canvasId,
          cameraId: input.cameraId,
          expected: input.expectedSettingsVersion,
          settings: input.settings
        });
    const commandId = `${rule.tag}:${operationId}`;
    const actorId = input.actorId ?? "world-camera";

    const derived = await initial.room.submitDerived({
      commandId,
      async derive(canvas) {
        if (options?.signal?.aborted) return { ok: false as const, code: "cancelled", message: "保存已取消" };
        const current = findCamera(canvas, input.cameraId);
        if (!current) return { ok: false as const, code: "not-found", message: "镜头不存在" };
        if (current.camera.settingsVersion !== input.expectedSettingsVersion) {
          return { ok: false as const, code: "version-conflict", message: "镜头配置已变化" };
        }
        const changedBinding = input.settings.boundInstanceId !== null
          && input.settings.boundInstanceId !== current.camera.boundInstanceId;
        // A missing existing binding is preserved. Only a newly assigned binding
        // (or an explicit restore) must resolve; otherwise the camera is reported
        // unavailable instead of being silently unbound or widened to the world.
        if (input.settings.boundInstanceId !== null && (changedBinding || rule.binding === "available")) {
          if (!hasInstance(canvas, input.settings.boundInstanceId)) {
            return { ok: false as const, code: "target-unavailable", message: "绑定的模型不存在或不可用" };
          }
        }
        const next = nextCamera(input.cameraId, input.settings);
        if ("ok" in next) return { ok: false as const, code: next.code, message: next.message };
        return {
          ok: true as const,
          batch: {
            protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
            canvasId: input.canvasId,
            commandId,
            actorId,
            baseRevision: canvas.revision,
            commands: [{ type: "nodeData.patch" as const, nodeId: current.nodeId, value: { [CAMERA_KEY]: next } as unknown as CanvasNodeData }]
          }
        };
      }
    }, {
      ...(capability ? { spatialContext: capability } : {}),
      ...(options?.authorize ? { authorize: options.authorize } : {}),
      ...(options?.signal ? { signal: options.signal } : {})
    }).catch(error => {
      const mapped = leaseFailure(error);
      return { ok: false as const, status: "rejected" as const, commandId, code: mapped.code, message: mapped.message };
    });

    if (!derived.ok) return resultFailure(derived);
    const after = await roomSnapshot(input.canvasId);
    if (!("room" in after)) return after;
    const saved = findCamera(after.canvas, input.cameraId);
    if (!saved) return failure("not-found", "镜头不存在");
    return {
      ok: true,
      canvasId: input.canvasId,
      cameraId: input.cameraId,
      commandId,
      revision: derived.revision,
      duplicate: derived.status === "duplicate",
      camera: saved.camera,
      settingsVersion: saved.camera.settingsVersion
    };
  }

  const service: WorldCameraSettingsService = {
    save(input, options) {
      return applyCamera(input, options, { binding: "new", tag: "world-camera-save" });
    },

    async restore(input: WorldCameraRestoreInput, options): Promise<WorldCameraRestoreOutcome> {
      if (!input || !nonEmpty(input.canvasId) || !nonEmpty(input.cameraId) || !nonEmpty(input.completionKey)) {
        return failure("invalid-data", "镜头恢复请求无效");
      }
      const entry = await deps.history.get(input.canvasId, input.completionKey);
      if (!entry) return failure("not-found", "找不到镜头历史");
      if (entry.cameraId !== input.cameraId || entry.snapshot.camera.cameraId !== input.cameraId) {
        return failure("invalid-data", "镜头历史身份不一致");
      }
      const applied = await applyCamera({
        canvasId: input.canvasId,
        cameraId: input.cameraId,
        expectedSettingsVersion: input.expectedSettingsVersion,
        settings: settingsOf(entry.snapshot.camera),
        ...(input.contextId ? { contextId: input.contextId } : {}),
        ...(input.actorId ? { actorId: input.actorId } : {}),
        operationId: `restore-${stableAuthorityVersion("world-camera-restore", {
          completionKey: input.completionKey,
          expected: input.expectedSettingsVersion
        })}`
      }, options, { binding: "available", tag: "world-camera-restore" });
      return applied.ok ? { ...applied, history: entry } : applied;
    },

    async history(input: WorldCameraHistoryListInput): Promise<WorldCameraHistoryListOutcome> {
      if (!input || !nonEmpty(input.canvasId) || !nonEmpty(input.cameraId)) {
        return failure("invalid-data", "镜头历史查询无效");
      }
      const entries = await deps.history.list(input.canvasId, input.cameraId, input.limit ?? 50);
      return { ok: true, canvasId: input.canvasId, cameraId: input.cameraId, entries };
    },

    async complete(input: WorldCameraCompletionIntake, options): Promise<WorldCameraCompletionOutcome> {
      if (!input || !record(input.completion)) return failure("invalid-data", "镜头完成身份无效");
      let key: string;
      try {
        key = worldCameraCompletionKey(input.completion);
      } catch {
        return failure("invalid-data", "镜头完成身份无效");
      }
      if (!deps.verifyCompletion) return failure("write-forbidden", "助手完成校验端口不可用");
      let verified: Awaited<ReturnType<WorldCameraCompletionVerifier>> = false;
      try {
        verified = await deps.verifyCompletion(input.completion, input.evidence);
      } catch {
        verified = false;
      }
      if (!verified) return failure("write-forbidden", "助手完成身份未通过宿主校验");
      const trustedSnapshot = typeof verified === "object" && verified !== null ? verified.snapshot : null;
      if (options?.signal?.aborted) return failure("cancelled", "完成登记已取消");

      const existing = await deps.history.get(input.completion.canvasId, key);
      if (existing) {
        if (
          existing.runId !== input.completion.runId ||
          existing.completionId !== input.completion.completionId ||
          existing.cameraId !== input.completion.cameraId ||
          existing.settingsVersion !== input.completion.settingsVersion
        ) {
          return failure("operation-conflict", "相同完成身份携带了不同镜头历史");
        }
        return { ok: true, duplicate: true, entry: existing };
      }

      const snapshot = await roomSnapshot(input.completion.canvasId);
      if (!("room" in snapshot)) return snapshot;
      let camera: WorldCameraData;
      if (trustedSnapshot) {
        // Trusted host fact: the run's frozen settings are authoritative even if
        // the current camera was edited, deleted or replaced after the run.
        const decoded = decodeWorldCamera(trustedSnapshot);
        if (!decoded.ok) return failure("invalid-data", "可信镜头完成快照无效");
        if (decoded.value.cameraId !== input.completion.cameraId) {
          return failure("invalid-data", "可信镜头完成快照身份不一致");
        }
        if (decoded.value.settingsVersion !== input.completion.settingsVersion) {
          return failure("version-conflict", "镜头设置版本与完成身份不一致");
        }
        camera = decoded.value;
      } else {
        // Untrusted/legacy retry: the current canonical camera must still match
        // the completion identity. Never silently record a newer edit as this
        // completion.
        const cameraNode = findCamera(snapshot.canvas, input.completion.cameraId);
        if (!cameraNode) return failure("target-unavailable", "完成对应的镜头不存在");
        if (cameraNode.camera.settingsVersion !== input.completion.settingsVersion) {
          return failure("version-conflict", "镜头设置版本与完成身份不一致");
        }
        camera = cameraNode.camera;
      }

      const snapshotValue = {
        version: WORLD_CAMERA_HISTORY_VERSION,
        completion: input.completion,
        camera
      } as const;
      let canonical;
      try {
        const encoded = encodeWorldCameraHistorySnapshot(snapshotValue);
        const decoded = decodeWorldCameraHistorySnapshot(encoded);
        if (!decoded.ok) return failure(decoded.code === "unsupported-version" ? "unsupported-version" : "invalid-data", "镜头历史快照无效");
        canonical = decoded.value;
      } catch {
        return failure("invalid-data", "镜头历史快照无效");
      }

      const entry: WorldCameraHistoryEntry = {
        completionKey: key,
        canvasId: input.completion.canvasId,
        cameraId: input.completion.cameraId,
        runId: input.completion.runId,
        completionId: input.completion.completionId,
        settingsVersion: input.completion.settingsVersion,
        createdAt: now(),
        snapshot: canonical
      };
      const inserted = await deps.history.insert(entry);
      if (inserted.status === "conflict") {
        return failure("operation-conflict", "相同完成身份携带了不同镜头历史");
      }
      return { ok: true, duplicate: inserted.status === "duplicate", entry: inserted.entry };
    }
  };

  return service;
}
