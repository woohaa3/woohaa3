/**
 * Continuous shared-world framing capture (T10).
 *
 * Owns the scheduling protocol only: immutable request from the canonical snapshot,
 * coalesced authoring changes, explicit supersede/cancel, late-result rejection,
 * trusted media verification and the click-time claim ledger. It never renders, reads
 * bytes back, writes camera history, triggers generation or treats viewport/hover/
 * heartbeat/cache events as authoring changes.
 */
import { randomUUID } from "node:crypto";
import {
  createWorldCaptureContentResolutionRequest,
  createWorldCaptureMediaSaveRequest,
  decodeWorldCaptureResourceReadyNotice,
  resolveWorldCaptureOutcome,
  worldCaptureContentResolutionOutcome,
  worldCaptureVersionKeysEqual,
  type WorldCaptureMediaSaveResult,
  type WorldCaptureProducer,
  type WorldCaptureProducerOutcome,
  type WorldCaptureRefreshOutcome,
  type WorldCaptureRequest
} from "@woohaa3/contracts";
import {
  buildWorldCaptureObservation,
  DEFAULT_OUTPUT_LONG_EDGE,
  listCameraIds,
  type Observation,
  type SnapshotResult
} from "./capture-snapshot.js";
import {
  DEFAULT_CLAIM_TTL_MS,
  DEFAULT_FREEZE_TIMEOUT_MS,
  emptyStatus,
  statusOf,
  type Attempt,
  type FramingState,
  type PendingPageCapture,
  type WorldCapturePagePrepareOutcome,
  type WorldCaptureService,
  type WorldCaptureServiceOptions
} from "./capture-service-types.js";
import { createCaptureClaimLedger } from "./capture-claims.js";
import { freezeMessage, waitForFreeze } from "./capture-wait.js";

export type { WorldCaptureClaimInput, WorldCaptureClaimResult, WorldCaptureService, WorldCaptureServiceOptions } from "./capture-service-types.js";

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function createWorldCaptureService(options: WorldCaptureServiceOptions): WorldCaptureService {
  const now = options.now ?? (() => Date.now());
  const outputLongEdge = options.outputLongEdge ?? DEFAULT_OUTPUT_LONG_EDGE;
  const freezeTimeoutMs = options.freezeTimeoutMs ?? DEFAULT_FREEZE_TIMEOUT_MS;
  const claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  const states = new Map<string, FramingState>();
  const claims = createCaptureClaimLedger({ now, claimTtlMs });
  let producer: WorldCaptureProducer | null = null;
  let producerToken = 0;
  let disposed = false;

  const log = (event: Record<string, unknown>) => options.logger?.(event);
  const stateKey = (canvasId: string, cameraId: string) => `${canvasId}\u0000${cameraId}`;

  function ensureState(canvasId: string, cameraId: string): FramingState {
    const key = stateKey(canvasId, cameraId);
    const existing = states.get(key);
    if (existing) return existing;
    const created: FramingState = {
      canvasId,
      cameraId,
      key: null,
      phase: "empty",
      stale: false,
      attemptCounter: 0
    };
    states.set(key, created);
    return created;
  }

  function supersedeAttempt(state: FramingState): void {
    const attempt = state.attempt;
    if (!attempt) return;
    state.attempt = undefined;
    attempt.controller.abort();
  }

  function applyFailure(state: FramingState, phase: "failed" | "unavailable", reason: string): void {
    state.phase = phase;
    state.reason = reason;
    state.stale = state.frozen !== undefined;
  }

  async function saveImage(input: {
    request: WorldCaptureRequest;
    outcome: Extract<WorldCaptureProducerOutcome, { status: "image" }>;
  }): Promise<WorldCaptureMediaSaveResult | null> {
    if (!options.mediaSave) return null;
    const saveRequest = createWorldCaptureMediaSaveRequest(input.request, input.outcome.image);
    if (!saveRequest.ok) return null;
    return options.mediaSave.save(saveRequest.value);
  }

  async function runAttempt(state: FramingState, observation: Observation, attempt: Attempt): Promise<void> {
    try {
      if (!producer) {
        applyFailure(state, "unavailable", "producer-missing");
        return;
      }
      const request = observation.request;
      if (request.subject.kind === "bound-missing") {
        applyFailure(state, "unavailable", "bound-target-missing");
        return;
      }
      state.phase = "capturing";
      state.reason = undefined;
      state.lastRequestId = request.requestId;
      state.lastContentFingerprint = request.contentFingerprint;

      if (producer.resolveContent) {
        const resolution = await producer.resolveContent.resolve(
          createWorldCaptureContentResolutionRequest(request)
        );
        const early = worldCaptureContentResolutionOutcome(request, resolution);
        if (early) {
          applyProducerOutcome(state, attempt, observation, early, undefined);
          return;
        }
      }
      if (attempt.controller.signal.aborted) {
        applyProducerOutcome(state, attempt, observation, {
          status: "cancelled",
          requestId: request.requestId,
          key: request.key,
          contentFingerprint: request.contentFingerprint
        }, undefined);
        return;
      }

      const outcome = await producer.capture(request, { signal: attempt.controller.signal });
      let saved: WorldCaptureMediaSaveResult | undefined;
      const first = resolveWorldCaptureOutcome({
        request,
        currentKey: state.key!,
        cancelled: attempt.controller.signal.aborted,
        outcome
      });
      if (first.status === "media-required") {
        const receipt = await saveImage({ request, outcome: outcome as Extract<WorldCaptureProducerOutcome, { status: "image" }> });
        // A missing save port is an explicit failure, never a frozen fake media id.
        saved = receipt ?? {
          status: "failed",
          requestId: request.requestId,
          key: request.key,
          contentFingerprint: request.contentFingerprint,
          code: "write-failed"
        };
      }
      applyProducerOutcome(state, attempt, observation, outcome, saved);
    } catch (error) {
      if (state.attempt !== attempt) return;
      applyFailure(state, "failed", error instanceof Error ? error.message : "capture-failed");
      log({
        event: "world-capture-attempt-failed",
        canvasId: state.canvasId,
        cameraId: state.cameraId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  function applyProducerOutcome(
    state: FramingState,
    attempt: Attempt,
    observation: Observation,
    outcome: WorldCaptureProducerOutcome,
    saved: WorldCaptureMediaSaveResult | undefined
  ): void {
    if (state.attempt !== attempt || disposed) return;
    // The attempt may have been superseded while the renderer/media port was working.
    if (!state.key || !worldCaptureVersionKeysEqual(state.key, observation.key)) return;
    if (attempt.controller.signal.aborted && outcome.status !== "cancelled") return;

    const decision = resolveWorldCaptureOutcome({
      request: observation.request,
      currentKey: state.key,
      cancelled: attempt.controller.signal.aborted,
      outcome,
      ...(saved ? { saved } : {})
    });
    switch (decision.status) {
      case "ready": {
        state.frozen = decision.input;
        state.phase = "ready";
        state.stale = false;
        state.reason = undefined;
        state.width = decision.input.media.width;
        state.height = decision.input.media.height;
        return;
      }
      case "media-required":
        // No trusted save port produced a receipt; keep the old framing marked stale.
        applyFailure(state, "failed", "media-save-unavailable");
        return;
      case "waiting":
        state.phase = "waiting";
        state.reason = decision.reason;
        state.stale = state.frozen !== undefined;
        return;
      case "unavailable":
        applyFailure(state, "unavailable", decision.reason);
        return;
      case "failed":
        applyFailure(state, "failed", decision.code);
        return;
      case "cancelled":
        state.phase = "cancelled";
        state.reason = "cancelled";
        state.stale = state.frozen !== undefined;
        return;
      case "rejected":
        applyFailure(state, "failed", decision.code);
        return;
      case "superseded":
        // Do not overwrite a newer attempt with the old result.
        return;
    }
  }

  async function startAttempt(
    state: FramingState,
    observation: Observation
  ): Promise<void> {
    if (disposed) return;
    state.observation = observation;
    if (!producer) {
      // 页面驱动渲染：宿主只登记待取景，等待前端渲染并把帧提交回来。
      supersedeAttempt(state);
      state.key = observation.key;
      state.phase = "waiting";
      state.reason = "page-render-pending";
      state.stale = state.frozen !== undefined;
      state.lastRequestId = observation.request.requestId;
      state.lastContentFingerprint = observation.request.contentFingerprint;
      return;
    }
    state.attemptCounter += 1;
    const attempt: Attempt = {
      attemptId: state.attemptCounter,
      requestId: observation.request.requestId,
      key: observation.key,
      controller: new AbortController(),
      promise: Promise.resolve()
    };
    state.key = observation.key;
    state.phase = "capturing";
    state.reason = undefined;
    state.lastRequestId = observation.request.requestId;
    state.lastContentFingerprint = observation.request.contentFingerprint;
    state.attempt = attempt;
    attempt.promise = runAttempt(state, observation, attempt).finally(() => {
      if (state.attempt === attempt) state.attempt = undefined;
    });
    await attempt.promise;
  }

  async function observeFromRoom(canvasId: string, cameraId: string): Promise<SnapshotResult | { ok: false; code: "canvas-not-found"; message: string }> {
    const room = await options.resolveRoom(canvasId);
    if (!room) return { ok: false, code: "canvas-not-found", message: "画布不存在" };
    const exported = room.exportCanvas();
    if (!exported.ok) return { ok: false, code: "canvas-not-found", message: exported.message };
    const state = ensureState(canvasId, cameraId);
    return buildWorldCaptureObservation({
      canvasId,
      canvas: exported.canvas,
      cameraId,
      outputLongEdge,
      attemptCounter: state.attemptCounter + 1
    });
  }

  async function refreshInternal(canvasId: string, cameraId: string): Promise<WorldCaptureRefreshOutcome> {
    const observed = await observeFromRoom(canvasId, cameraId);
    if (!observed.ok) {
      const state = ensureState(canvasId, cameraId);
      state.stale = state.frozen !== undefined;
      if (observed.code === "camera-not-found") applyFailure(state, "unavailable", "camera-not-found");
      return { ok: false, code: observed.code, message: observed.message, status: statusOf(state) };
    }
    const state = ensureState(canvasId, cameraId);
    const observation = observed.observation;
    if (state.key && worldCaptureVersionKeysEqual(state.key, observation.key)) {
      if (state.phase === "ready") return { ok: true, status: statusOf(state) };
      if (state.attempt) {
        await state.attempt.promise;
        return { ok: true, status: statusOf(state) };
      }
    } else {
      supersedeAttempt(state);
      state.key = observation.key;
      // The previous frozen input belongs to an older key: keep it viewable but stale.
      state.stale = state.frozen !== undefined;
      state.phase = "capturing";
    }
    await startAttempt(state, observation);
    return { ok: true, status: statusOf(state) };
  }

  function publicState(canvasId: string, cameraId: string): FramingState {
    return ensureState(canvasId, cameraId);
  }

  return {
    registerProducer(candidate) {
      if (!candidate || !nonEmpty(candidate.producerId) || typeof candidate.capture !== "function") {
        throw new Error("world capture producer requires producerId and capture()");
      }
      if (producer) {
        if (producer.producerId !== candidate.producerId) {
          throw new Error("world capture producer already registered");
        }
        // Replacing the exact same identity is idempotent for page re-mounts.
      }
      producer = candidate;
      const token = ++producerToken;
      log({ event: "world-capture-producer-registered", producerId: candidate.producerId });
      // Newly registered producers can serve cameras that were waiting/unavailable.
      for (const state of states.values()) {
        if (state.phase === "unavailable" && state.reason === "producer-missing") {
          state.phase = "waiting";
          state.reason = "producer-registered";
          if (state.observation) {
            supersedeAttempt(state);
            void startAttempt(state, state.observation).catch(() => undefined);
          }
        }
      }
      return {
        producerId: candidate.producerId,
        unregister() {
          if (!producer || producer.producerId !== candidate.producerId || token !== producerToken) return;
          producer = null;
          producerToken += 1;
          for (const state of states.values()) {
            supersedeAttempt(state);
            state.phase = "unavailable";
            state.reason = "producer-unregistered";
            state.stale = state.frozen !== undefined;
          }
          log({ event: "world-capture-producer-unregistered", producerId: candidate.producerId });
        }
      };
    },

    notifyResourcesReady(notice) {
      const decoded = decodeWorldCaptureResourceReadyNotice(notice);
      if (!decoded.ok) return;
      for (const state of states.values()) {
        if (state.canvasId !== decoded.value.canvasId) continue;
        if (decoded.value.cameraId !== undefined && state.cameraId !== decoded.value.cameraId) continue;
        if (decoded.value.requestId !== undefined && state.lastRequestId !== decoded.value.requestId) continue;
        if (
          decoded.value.contentFingerprint !== undefined &&
          state.lastContentFingerprint !== decoded.value.contentFingerprint
        ) {
          continue;
        }
        if (state.phase !== "waiting" && state.phase !== "unavailable") continue;
        void refreshInternal(state.canvasId, state.cameraId).catch(() => undefined);
      }
    },

    observeCanonical(input) {
      if (disposed) return;
      const cameraIds = listCameraIds(input.canvas);
      for (const cameraId of cameraIds) {
        const observed = buildWorldCaptureObservation({
          canvasId: input.canvasId,
          canvas: input.canvas,
          cameraId,
          outputLongEdge,
          attemptCounter: publicState(input.canvasId, cameraId).attemptCounter + 1
        });
        const state = publicState(input.canvasId, cameraId);
        if (!observed.ok) {
          if (observed.code === "camera-not-found") continue;
          applyFailure(state, "failed", observed.message);
          continue;
        }
        if (state.key && worldCaptureVersionKeysEqual(state.key, observed.observation.key)) continue;
        supersedeAttempt(state);
        state.key = observed.observation.key;
        state.stale = state.frozen !== undefined;
        void startAttempt(state, observed.observation).catch(() => undefined);
      }
      // Removed cameras: settle explicitly instead of leaving a stale current framing.
      const present = new Set(cameraIds);
      for (const state of states.values()) {
        if (state.canvasId !== input.canvasId) continue;
        if (state.key === null) continue;
        if (!present.has(state.cameraId)) {
          supersedeAttempt(state);
          applyFailure(state, "unavailable", "camera-removed");
        }
      }
    },

    refresh: async ({ canvasId, cameraId }) => {
      return refreshInternal(canvasId, cameraId);
    },

    status: ({ canvasId, cameraId }) =>
      states.has(stateKey(canvasId, cameraId))
        ? statusOf(states.get(stateKey(canvasId, cameraId))!)
        : emptyStatus(canvasId, cameraId),

    pendingPageCaptures(canvasId) {
      const pending: PendingPageCapture[] = [];
      for (const state of states.values()) {
        if (state.canvasId !== canvasId) continue;
        if (state.phase !== "waiting" || !state.key) continue;
        const output = state.observation?.request.output;
        pending.push({
          canvasId: state.canvasId,
          cameraId: state.cameraId,
          key: state.key,
          width: output?.width ?? 0,
          height: output?.height ?? 0,
          ...(state.lastRequestId ? { requestId: state.lastRequestId } : {})
        });
      }
      return pending;
    },

    async freezeForGeneration({ canvasId, cameraId, requestId, signal }) {
      if (signal?.aborted) return { ok: false, code: "cancelled", message: "取景等待已取消" };
      const observed = await observeFromRoom(canvasId, cameraId);
      if (!observed.ok) {
        return {
          ok: false,
          code: observed.code === "camera-not-found" ? "camera-not-found" : observed.code,
          message: observed.message
        };
      }
      const state = ensureState(canvasId, cameraId);
      const target = observed.observation;
      const targetRequestId = requestId && nonEmpty(requestId)
        ? requestId
        : `world-capture-claim:${randomUUID()}`;
      if (state.key && worldCaptureVersionKeysEqual(state.key, target.key)) {
        if (state.phase === "ready" && !state.stale && state.frozen) {
          return claims.claim(state, target, targetRequestId);
        }
        if (!state.attempt) {
          void startAttempt(state, target).catch(() => undefined);
        }
      } else {
        supersedeAttempt(state);
        state.key = target.key;
        state.stale = state.frozen !== undefined;
        void startAttempt(state, target).catch(() => undefined);
      }

      const wait = await waitForFreeze(state, target.key, signal, freezeTimeoutMs);
      if (wait !== "ready") {
        if (wait === "timeout" && state.attempt) supersedeAttempt(state);
        return {
          ok: false,
          code: wait,
          message: freezeMessage(wait),
          requestedKey: target.key,
          ...(state.key && !worldCaptureVersionKeysEqual(state.key, target.key) ? { currentKey: state.key } : {}),
          status: statusOf(state)
        };
      }
      if (!state.key || !worldCaptureVersionKeysEqual(state.key, target.key) || !state.frozen || state.stale) {
        return {
          ok: false,
          code: "superseded",
          message: freezeMessage("superseded"),
          requestedKey: target.key,
          ...(state.key ? { currentKey: state.key } : {}),
          status: statusOf(state)
        };
      }
      return claims.claim(state, target, targetRequestId);
    },

    async preparePageCapture({ canvasId, cameraId }): Promise<WorldCapturePagePrepareOutcome> {
      if (disposed) return { ok: false, code: "capture-unavailable", message: "取景服务已关闭" };
      const observed = await observeFromRoom(canvasId, cameraId);
      if (!observed.ok) return { ok: false, code: observed.code, message: observed.message };
      const { observation } = observed;
      const state = ensureState(canvasId, cameraId);
      if (!state.key || !worldCaptureVersionKeysEqual(state.key, observation.key)) {
        supersedeAttempt(state);
        state.key = observation.key;
        state.stale = state.frozen !== undefined;
        state.phase = "capturing";
      }
      state.observation = observation;
      state.lastRequestId = observation.request.requestId;
      state.lastContentFingerprint = observation.request.contentFingerprint;
      return {
        ok: true,
        key: observation.key,
        width: observation.request.output.width,
        height: observation.request.output.height
      };
    },

    async commitPageCapture({ canvasId, cameraId, key, png, width, height }) {
      if (disposed) return { ok: false, code: "capture-unavailable", message: "取景服务已关闭" };
      const observed = await observeFromRoom(canvasId, cameraId);
      if (!observed.ok) {
        return {
          ok: false,
          code: observed.code === "camera-not-found" ? "camera-not-found" : observed.code,
          message: observed.message
        };
      }
      const { observation } = observed;
      const state = ensureState(canvasId, cameraId);
      state.key = observation.key;
      state.lastRequestId = observation.request.requestId;
      state.lastContentFingerprint = observation.request.contentFingerprint;
      if (!worldCaptureVersionKeysEqual(observation.key, key)) {
        state.stale = state.frozen !== undefined;
        return {
          ok: false,
          code: "superseded",
          message: "画布在页面渲染期间已变化，请重新取景",
          requestedKey: key,
          currentKey: observation.key,
          status: statusOf(state)
        };
      }
      const image = { bytes: png, contentType: "image/png", width, height };
      const saveRequest = createWorldCaptureMediaSaveRequest(observation.request, image);
      if (!saveRequest.ok) {
        return { ok: false, code: "invalid-data", message: "页面渲染的取景尺寸与当前输出不一致" };
      }
      const outcome: Extract<WorldCaptureProducerOutcome, { status: "image" }> = {
        status: "image",
        requestId: observation.request.requestId,
        key: observation.key,
        contentFingerprint: observation.request.contentFingerprint,
        image
      };
      const saved = options.mediaSave ? await options.mediaSave.save(saveRequest.value) : null;
      const decision = resolveWorldCaptureOutcome({
        request: observation.request,
        currentKey: observation.key,
        cancelled: false,
        outcome,
        ...(saved ? { saved } : {})
      });
      if (decision.status !== "ready") {
        const reason = decision.status === "media-required" ? "media-save-unavailable"
          : decision.status === "unavailable" ? decision.reason
            : decision.status === "failed" || decision.status === "rejected" ? decision.code
              : "capture-failed";
        applyFailure(state, "failed", reason);
        return { ok: false, code: "capture-not-ready", message: "页面取景提交失败", status: statusOf(state) };
      }
      state.frozen = decision.input;
      state.phase = "ready";
      state.stale = false;
      state.reason = undefined;
      state.width = decision.input.media.width;
      state.height = decision.input.media.height;
      state.observation = observation;
      // A new page render is a new freeze operation even when the scene version
      // is unchanged. Keep the version identity separate from its expiring claim.
      return claims.claim(state, observation, `world-capture-claim:${randomUUID()}`);
    },

    claimForGeneration(input) {
      return claims.claimForGeneration(input);
    },

    forgetCanvas(canvasId) {
      for (const [key, state] of states) {
        if (state.canvasId !== canvasId) continue;
        supersedeAttempt(state);
        states.delete(key);
      }
      claims.forgetCanvas(canvasId);
    },

    dispose() {
      disposed = true;
      for (const state of states.values()) supersedeAttempt(state);
      states.clear();
      claims.clear();
      producer = null;
    }
  };


}
