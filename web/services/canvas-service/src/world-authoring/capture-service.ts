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
  worldCaptureDynamicBaseKey,
  createWorldCaptureContentResolutionRequest,
  createWorldCaptureDynamicContentResolutionRequest,
  createWorldCaptureDynamicMediaSaveRequest,
  createWorldCaptureMediaSaveRequest,
  decodeWorldCaptureResourceReadyNotice,
  resolveWorldCaptureDynamicOutcome,
  resolveWorldCaptureOutcome,
  worldCaptureContentResolutionOutcome,
  worldCaptureDynamicKeysEqual,
  worldCaptureVersionKeysEqual,
  type WorldCaptureDynamicProducerOutcome,
  type WorldCaptureDynamicSaveResult,
  type WorldCaptureMediaSaveResult,
  type WorldCaptureProducer,
  type WorldCaptureProducerOutcome,
  type WorldCaptureRefreshOutcome,
  type WorldCaptureRequest
} from "@woohaa3/contracts";
import {
  buildWorldCameraObservation,
  DEFAULT_OUTPUT_LONG_EDGE,
  listCameraIds,
  type CameraObservation,
  type CameraObservationResult,
  type DynamicCameraObservation
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
  type WorldCaptureServiceOptions,
  type WorldCaptureVideoProducer
} from "./capture-service-types.js";
import { createCaptureClaimLedger } from "./capture-claims.js";
import { freezeMessage, waitForFreeze } from "./capture-wait.js";

export type { WorldCaptureClaimInput, WorldCaptureClaimResult, WorldCaptureService, WorldCaptureServiceOptions } from "./capture-service-types.js";

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 静态图片或动态视频任一已冻结，都算「有可查看的旧结果」。 */
function hasFrozenContent(state: FramingState): boolean {
  return state.frozen !== undefined || state.frozenVideo !== undefined;
}

/**
 * 调度状态里保存的始终是**基础六字段键**。动态键额外带动画/区间/fps，
 * 若直接拿它去做 `worldCaptureVersionKeysEqual`（严格六字段解码）会永远不相等，
 * 于是每次冻结都被误判为 superseded。动态性单独存在 `state.dynamicKey`。
 */
function baseKeyOf(observation: CameraObservation): import("@woohaa3/contracts").WorldCaptureVersionKey {
  return observation.kind === "dynamic"
    ? worldCaptureDynamicBaseKey(observation.key)
    : observation.key;
}

export function createWorldCaptureService(options: WorldCaptureServiceOptions): WorldCaptureService {
  const now = options.now ?? (() => Date.now());
  const outputLongEdge = options.outputLongEdge ?? DEFAULT_OUTPUT_LONG_EDGE;
  const freezeTimeoutMs = options.freezeTimeoutMs ?? DEFAULT_FREEZE_TIMEOUT_MS;
  const claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  const states = new Map<string, FramingState>();
  const claims = createCaptureClaimLedger({ now, claimTtlMs });
  let producer: WorldCaptureProducer | null = null;
  let videoProducer: WorldCaptureVideoProducer | null = null;
  let videoProducerToken = 0;
  let producerToken = 0;
  let disposed = false;

  const log = (event: Record<string, unknown>) => options.logger?.(event);
  const stateKey = (canvasId: string, cameraId: string) => `${canvasId}\u0000${cameraId}`;

  function expirePageProgress(state: FramingState): void {
    if (state.phase === "waiting" && state.pageProgressAt !== undefined && now() - state.pageProgressAt > 90_000) {
      applyFailure(state, "failed", state.pageProgress ? "page-capture-stalled" : "page-unavailable");
      state.pageAttemptId = undefined;
    }
  }

  function ensureState(canvasId: string, cameraId: string): FramingState {
    const key = stateKey(canvasId, cameraId);
    const existing = states.get(key);
    if (existing) return existing;
    const created: FramingState = {
      canvasId,
      cameraId,
      key: null,
      kind: "static",
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
    state.stale = hasFrozenContent(state);
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

  async function runAttempt(state: FramingState, observation: CameraObservation, attempt: Attempt): Promise<void> {
    if (observation.kind === "dynamic") return runDynamicAttempt(state, observation, attempt);
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
    observation: Extract<CameraObservation, { kind: "static" }>,
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
        state.stale = hasFrozenContent(state);
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
        state.stale = hasFrozenContent(state);
        return;
      case "rejected":
        applyFailure(state, "failed", decision.code);
        return;
      case "superseded":
        // Do not overwrite a newer attempt with the old result.
        return;
    }
  }

  /** 应用一次动态结果：只有键相等且保存校验通过才发布 ready。 */
  function applyDynamicOutcome(
    state: FramingState,
    attempt: Attempt,
    observation: DynamicCameraObservation,
    outcome: WorldCaptureDynamicProducerOutcome,
    saved: WorldCaptureDynamicSaveResult | undefined
  ): void {
    if (state.attempt !== attempt || disposed) return;
    if (!state.key || !state.dynamicKey || !worldCaptureVersionKeysEqual(state.key, baseKeyOf(observation))) return;
    if (!worldCaptureDynamicKeysEqual(state.dynamicKey, observation.key)) return;
    if (attempt.controller.signal.aborted && outcome.status !== "cancelled") return;

    const decision = resolveWorldCaptureDynamicOutcome({
      request: observation.request,
      currentKey: observation.key,
      cancelled: attempt.controller.signal.aborted,
      outcome,
      ...(saved ? { saved } : {})
    });
    switch (decision.status) {
      case "ready": {
        state.frozenVideo = decision.frozen;
        state.frozen = undefined;
        state.phase = "ready";
        state.stale = false;
        state.reason = undefined;
        state.width = decision.frozen.media.width;
        state.height = decision.frozen.media.height;
        state.durationSeconds = observation.durationSeconds;
        return;
      }
      case "media-required":
        applyFailure(state, "failed", "video-media-save-unavailable");
        return;
      case "waiting":
        state.phase = "waiting";
        state.reason = decision.reason;
        state.stale = state.frozenVideo !== undefined;
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
        state.stale = state.frozenVideo !== undefined;
        return;
      case "rejected":
        applyFailure(state, "failed", decision.code);
        return;
      case "superseded":
        return;
    }
  }

  async function runDynamicAttempt(
    state: FramingState,
    observation: DynamicCameraObservation,
    attempt: Attempt
  ): Promise<void> {
    try {
      if (!videoProducer) {
        applyFailure(state, "unavailable", "dynamic-renderer-unavailable");
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

      if (videoProducer.resolveContent) {
        const resolution = await videoProducer.resolveContent.resolve(
          createWorldCaptureDynamicContentResolutionRequest(request)
        );
        if (resolution.requestId !== request.requestId ||
            resolution.contentFingerprint !== request.contentFingerprint) {
          applyDynamicOutcome(state, attempt, observation, {
            status: "failed",
            requestId: request.requestId,
            key: request.key,
            contentFingerprint: request.contentFingerprint,
            code: "content-mismatch"
          }, undefined);
          return;
        }
        if (resolution.status === "waiting") {
          applyDynamicOutcome(state, attempt, observation, {
            status: "waiting",
            requestId: request.requestId,
            key: request.key,
            contentFingerprint: request.contentFingerprint,
            reason: resolution.reason ?? "resources-not-ready"
          }, undefined);
          return;
        }
        if (resolution.status === "unavailable") {
          applyDynamicOutcome(state, attempt, observation, {
            status: "unavailable",
            requestId: request.requestId,
            key: request.key,
            contentFingerprint: request.contentFingerprint,
            reason: resolution.reason ?? "content-unavailable"
          }, undefined);
          return;
        }
        if (resolution.status === "failed") {
          applyDynamicOutcome(state, attempt, observation, {
            status: "failed",
            requestId: request.requestId,
            key: request.key,
            contentFingerprint: request.contentFingerprint,
            code: resolution.code ?? "render-failed"
          }, undefined);
          return;
        }
      }
      if (attempt.controller.signal.aborted) {
        applyDynamicOutcome(state, attempt, observation, {
          status: "cancelled",
          requestId: request.requestId,
          key: request.key,
          contentFingerprint: request.contentFingerprint
        }, undefined);
        return;
      }

      const outcome = await videoProducer.captureVideo(request, { signal: attempt.controller.signal });
      let saved: WorldCaptureDynamicSaveResult | undefined;
      const first = resolveWorldCaptureDynamicOutcome({
        request,
        currentKey: request.key,
        cancelled: attempt.controller.signal.aborted,
        outcome
      });
      if (first.status === "media-required") {
        const saveRequest = options.videoMediaSave && outcome.status === "video"
          ? createWorldCaptureDynamicMediaSaveRequest(request, outcome.video)
          : null;
        saved = saveRequest?.ok
          ? await options.videoMediaSave!.save(saveRequest.value)
          : {
              status: "failed",
              requestId: request.requestId,
              key: request.key,
              contentFingerprint: request.contentFingerprint,
              code: "write-failed"
            };
      }
      applyDynamicOutcome(state, attempt, observation, outcome, saved);
    } catch (error) {
      if (state.attempt !== attempt) return;
      applyFailure(state, "failed", error instanceof Error ? error.message : "capture-failed");
      log({
        event: "world-capture-dynamic-attempt-failed",
        canvasId: state.canvasId,
        cameraId: state.cameraId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async function startAttempt(
    state: FramingState,
    observation: CameraObservation
  ): Promise<void> {
    if (disposed) return;
    state.observation = observation;
    state.kind = observation.kind;
    state.durationSeconds = observation.kind === "dynamic" ? observation.durationSeconds : undefined;
    state.dynamicKey = observation.kind === "dynamic" ? observation.key : null;
    const attemptKey = baseKeyOf(observation);
    if (observation.kind === "dynamic" && !videoProducer) {
      // 没有原生视频 producer 时走页面录制：宿主登记待取景，前端逐帧渲染 + WebCodecs 编码。
      supersedeAttempt(state);
      state.key = attemptKey;
      state.phase = "waiting";
      state.reason = "page-render-pending";
      state.pageAttemptId = randomUUID();
      state.pageProgressAt = now();
      state.pageProgress = undefined;
      state.stale = hasFrozenContent(state);
      state.lastRequestId = observation.request.requestId;
      state.lastContentFingerprint = observation.request.contentFingerprint;
      return;
    }
    if (observation.kind === "static" && !producer) {
      // 页面驱动渲染：宿主只登记待取景，等待前端渲染并把帧提交回来。
      supersedeAttempt(state);
      state.key = attemptKey;
      state.phase = "waiting";
      state.reason = "page-render-pending";
      state.pageAttemptId = randomUUID();
      state.pageProgressAt = now();
      state.pageProgress = undefined;
      state.stale = hasFrozenContent(state);
      state.lastRequestId = observation.request.requestId;
      state.lastContentFingerprint = observation.request.contentFingerprint;
      return;
    }
    state.attemptCounter += 1;
    const attempt: Attempt = {
      attemptId: state.attemptCounter,
      requestId: observation.request.requestId,
      key: attemptKey,
      controller: new AbortController(),
      promise: Promise.resolve()
    };
    state.key = attemptKey;
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

  async function observeFromRoom(
    canvasId: string,
    cameraId: string
  ): Promise<CameraObservationResult | { ok: false; code: "canvas-not-found"; message: string }> {
    const room = await options.resolveRoom(canvasId);
    if (!room) return { ok: false, code: "canvas-not-found", message: "画布不存在" };
    const exported = room.exportCanvas();
    if (!exported.ok) return { ok: false, code: "canvas-not-found", message: exported.message };
    const state = ensureState(canvasId, cameraId);
    return buildWorldCameraObservation({
      canvasId,
      canvas: exported.canvas,
      cameraId,
      outputLongEdge,
      attemptCounter: state.attemptCounter + 1,
      ...(options.dynamicOutputLongEdge !== undefined ? { dynamicOutputLongEdge: options.dynamicOutputLongEdge } : {}),
      ...(options.dynamicFps !== undefined ? { fps: options.dynamicFps } : {})
    });
  }

  async function refreshInternal(canvasId: string, cameraId: string): Promise<WorldCaptureRefreshOutcome> {
    const observed = await observeFromRoom(canvasId, cameraId);
    if (!observed.ok) {
      const state = ensureState(canvasId, cameraId);
      state.stale = hasFrozenContent(state);
      if (observed.code === "camera-not-found") applyFailure(state, "unavailable", "camera-not-found");
      return { ok: false, code: observed.code, message: observed.message, status: statusOf(state) };
    }
    const state = ensureState(canvasId, cameraId);
    expirePageProgress(state);
    const observation = observed.observation;
    const observedKey = baseKeyOf(observation);
    if (state.key && worldCaptureVersionKeysEqual(state.key, observedKey)) {
      if (state.phase === "ready") return { ok: true, status: statusOf(state) };
      if (state.attempt) {
        await state.attempt.promise;
        return { ok: true, status: statusOf(state) };
      }
    } else {
      supersedeAttempt(state);
      state.key = observedKey;
      // The previous frozen input belongs to an older key: keep it viewable but stale.
      state.stale = hasFrozenContent(state);
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
            state.stale = hasFrozenContent(state);
          }
          log({ event: "world-capture-producer-unregistered", producerId: candidate.producerId });
        }
      };
    },

    registerVideoProducer(candidate) {
      if (!candidate || !nonEmpty(candidate.producerId) || typeof candidate.captureVideo !== "function") {
        throw new Error("world video producer requires producerId and captureVideo()");
      }
      if (videoProducer && videoProducer.producerId !== candidate.producerId) {
        throw new Error("world video producer already registered");
      }
      videoProducer = candidate;
      const token = ++videoProducerToken;
      log({ event: "world-video-producer-registered", producerId: candidate.producerId });
      for (const state of states.values()) {
        if (state.kind !== "dynamic") continue;
        if (state.phase === "unavailable" && state.reason === "dynamic-renderer-unavailable" && state.observation) {
          void startAttempt(state, state.observation).catch(() => undefined);
        }
      }
      return {
        producerId: candidate.producerId,
        unregister() {
          if (!videoProducer || videoProducer.producerId !== candidate.producerId || token !== videoProducerToken) return;
          videoProducer = null;
          videoProducerToken += 1;
          for (const state of states.values()) {
            if (state.kind !== "dynamic") continue;
            supersedeAttempt(state);
            state.phase = "unavailable";
            state.reason = "dynamic-renderer-unavailable";
            state.stale = hasFrozenContent(state);
          }
          log({ event: "world-video-producer-unregistered", producerId: candidate.producerId });
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
        const observed = buildWorldCameraObservation({
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
        if (state.key && worldCaptureVersionKeysEqual(state.key, baseKeyOf(observed.observation))) continue;
        supersedeAttempt(state);
        state.key = baseKeyOf(observed.observation);
        state.stale = hasFrozenContent(state);
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

    status: ({ canvasId, cameraId }) => {
      const state = states.get(stateKey(canvasId, cameraId));
      if (!state) return emptyStatus(canvasId, cameraId);
      expirePageProgress(state);
      return statusOf(state);
    },

    statuses(canvasId) {
      const result: import("@woohaa3/contracts").WorldCaptureFramingStatus[] = [];
      for (const state of states.values()) {
        if (state.canvasId === canvasId) { expirePageProgress(state); result.push(statusOf(state)); }
      }
      return result;
    },

    reportPageProgress(canvasId, input) {
      const state = states.get(stateKey(canvasId, input.cameraId));
      if (disposed || !state || !input.attemptId || state.pageAttemptId !== input.attemptId || state.phase !== "waiting"
        || !["rendering", "encoding", "uploading", "failed"].includes(input.stage)) return false;
      if (input.completedFrames !== undefined && (!Number.isInteger(input.completedFrames) || input.completedFrames < 0)) return false;
      if (input.totalFrames !== undefined && (!Number.isInteger(input.totalFrames) || input.totalFrames <= 0
        || (input.completedFrames ?? 0) > input.totalFrames)) return false;
      const previous = state.pageProgress;
      const stages = ["rendering", "encoding", "uploading", "failed"];
      if (previous && (stages.indexOf(input.stage) < stages.indexOf(previous.stage)
        || (input.stage === previous.stage && (input.completedFrames ?? 0) < (previous.completedFrames ?? 0)))) return false;
      if (!previous || previous.stage !== input.stage || (input.completedFrames ?? 0) > (previous.completedFrames ?? 0)) {
        state.pageProgressAt = now();
      }
      state.pageProgress = { ...input };
      const reason = input.reason && /^[a-z0-9-]{1,80}$/.test(input.reason) ? input.reason : "capture-unavailable";
      if (input.stage === "failed") { applyFailure(state, "failed", reason); state.pageAttemptId = undefined; }
      else state.reason = `page-${input.stage}${input.totalFrames ? `:${input.completedFrames ?? 0}/${input.totalFrames}` : ""}`;
      return true;
    },

    pendingPageCaptures(canvasId) {
      const pending: PendingPageCapture[] = [];
      for (const state of states.values()) {
        if (state.canvasId !== canvasId) continue;
        expirePageProgress(state);
        if (state.phase !== "waiting" || !state.key) continue;
        const output = state.observation?.request.output;
        const observation = state.observation;
        const dynamic = observation?.kind === "dynamic" ? observation : null;
        pending.push({
          canvasId: state.canvasId,
          cameraId: state.cameraId,
          attemptId: state.pageAttemptId,
          key: state.key,
          width: output?.width ?? 0,
          height: output?.height ?? 0,
          kind: state.kind,
          ...(dynamic
            ? {
                dynamicKey: dynamic.key,
                fps: dynamic.key.fps,
                timeRange: dynamic.key.timeRange,
                ...(dynamic.shot.animation ? { animationNodeId: dynamic.shot.animation.areaNodeId } : {})
              }
            : {}),
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
      expirePageProgress(state);
      const target = observed.observation;
      const targetKey = baseKeyOf(target);
      const targetRequestId = requestId && nonEmpty(requestId)
        ? requestId
        : `world-capture-claim:${randomUUID()}`;
      if (state.key && worldCaptureVersionKeysEqual(state.key, targetKey)) {
        if (state.phase === "ready" && !state.stale && hasFrozenContent(state)) {
          return claims.claim(state, target, targetRequestId);
        }
        if (!state.attempt && !(state.phase === "waiting" && state.pageAttemptId)) {
          void startAttempt(state, target).catch(() => undefined);
        }
      } else {
        supersedeAttempt(state);
        state.key = targetKey;
        state.stale = hasFrozenContent(state);
        void startAttempt(state, target).catch(() => undefined);
      }

      const wait = await waitForFreeze(state, targetKey, signal, freezeTimeoutMs);
      if (wait !== "ready") {
        // A consumer's timeout must not cancel the shared producer: another
        // consumer may still be waiting for this exact frozen version.
        return {
          ok: false,
          code: wait,
          message: freezeMessage(wait),
          requestedKey: targetKey,
          ...(state.key && !worldCaptureVersionKeysEqual(state.key, targetKey) ? { currentKey: state.key } : {}),
          status: statusOf(state)
        };
      }
      if (!state.key || !worldCaptureVersionKeysEqual(state.key, targetKey) || !hasFrozenContent(state) || state.stale) {
        return {
          ok: false,
          code: "superseded",
          message: freezeMessage("superseded"),
          requestedKey: targetKey,
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
      if (observation.kind === "dynamic") {
        return {
          ok: false,
          code: "dynamic-capture-unsupported",
          message: "动态镜头需要原生视频编码，浏览器页面取景不可用"
        };
      }
      const state = ensureState(canvasId, cameraId);
      const observedKey = baseKeyOf(observation);
      if (!state.key || !worldCaptureVersionKeysEqual(state.key, observedKey)
        || state.phase !== "waiting" || !state.pageAttemptId) {
        supersedeAttempt(state);
        state.key = observedKey;
        state.stale = hasFrozenContent(state);
        state.phase = "waiting";
        state.reason = "page-render-pending";
        state.pageAttemptId = randomUUID();
        state.pageProgressAt = now();
        state.pageProgress = undefined;
      }
      state.observation = observation;
      state.lastRequestId = observation.request.requestId;
      state.lastContentFingerprint = observation.request.contentFingerprint;
      return {
        ok: true,
        key: observedKey,
        attemptId: state.pageAttemptId ??= randomUUID(),
        width: observation.request.output.width,
        height: observation.request.output.height
      };
    },

    async commitPageCapture({ canvasId, cameraId, key, png, width, height, attemptId }) {
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
      if (observation.kind === "dynamic") {
        return {
          ok: false,
          code: "dynamic-capture-unsupported",
          message: "动态镜头需要原生视频编码，浏览器页面取景不可用"
        };
      }
      const state = ensureState(canvasId, cameraId);
      const pageAttemptId = state.pageAttemptId;
      if (attemptId !== undefined && attemptId !== pageAttemptId) {
        return { ok: false, code: "superseded", message: "该次取景已被重试替代，请使用当前取景请求" };
      }
      state.key = observation.key;
      state.lastRequestId = observation.request.requestId;
      state.lastContentFingerprint = observation.request.contentFingerprint;
      if (!worldCaptureVersionKeysEqual(observation.key, key)) {
        state.stale = hasFrozenContent(state);
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
      // Saving bytes may outlive a world/camera edit or service shutdown. Re-read
      // canonical content after I/O before publishing a ready result.
      const current = await observeFromRoom(canvasId, cameraId);
      if (disposed || state.pageAttemptId !== pageAttemptId || !current.ok || current.observation.kind !== "static"
        || !worldCaptureVersionKeysEqual(current.observation.key, key)) {
        return { ok: false, code: "superseded", message: "保存取景期间画布已变化，请重新取景", status: statusOf(state) };
      }
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

    async commitPageVideoCapture({ canvasId, cameraId, key, video, attemptId }) {
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
      if (observation.kind !== "dynamic") {
        return { ok: false, code: "invalid-data", message: "该镜头不是动态取景" };
      }
      const state = ensureState(canvasId, cameraId);
      const pageAttemptId = state.pageAttemptId;
      if (attemptId !== undefined && attemptId !== pageAttemptId) {
        return { ok: false, code: "superseded", message: "该次取景已被重试替代，请使用当前取景请求" };
      }
      state.key = baseKeyOf(observation);
      state.dynamicKey = observation.key;
      state.kind = "dynamic";
      state.durationSeconds = observation.durationSeconds;
      state.lastRequestId = observation.request.requestId;
      state.lastContentFingerprint = observation.request.contentFingerprint;
      if (!worldCaptureDynamicKeysEqual(observation.key, key)) {
        state.stale = hasFrozenContent(state);
        return {
          ok: false,
          code: "superseded",
          message: "画布在页面录制期间已变化，请重新取景",
          requestedKey: baseKeyOf(observation),
          currentKey: state.key,
          status: statusOf(state)
        };
      }
      const saveRequest = createWorldCaptureDynamicMediaSaveRequest(observation.request, video);
      if (!saveRequest.ok) {
        return { ok: false, code: "invalid-data", message: "页面录制的视频尺寸或时长与当前输出不一致" };
      }
      const saved = options.videoMediaSave
        ? await options.videoMediaSave.save(saveRequest.value)
        : null;
      const current = await observeFromRoom(canvasId, cameraId);
      if (disposed || state.pageAttemptId !== pageAttemptId || !current.ok || current.observation.kind !== "dynamic"
        || !worldCaptureDynamicKeysEqual(current.observation.key, key)) {
        return { ok: false, code: "superseded", message: "保存视频取景期间画布已变化，请重新取景", status: statusOf(state) };
      }
      const outcome: WorldCaptureDynamicProducerOutcome = {
        status: "video",
        requestId: observation.request.requestId,
        key: observation.key,
        contentFingerprint: observation.request.contentFingerprint,
        video
      };
      const decision = resolveWorldCaptureDynamicOutcome({
        request: observation.request,
        currentKey: observation.key,
        cancelled: false,
        outcome,
        ...(saved ? { saved } : {})
      });
      if (decision.status !== "ready") {
        const reason = decision.status === "media-required" ? "video-media-save-unavailable"
          : decision.status === "unavailable" ? decision.reason
            : decision.status === "failed" || decision.status === "rejected" ? decision.code
              : "capture-failed";
        applyFailure(state, "failed", reason);
        return { ok: false, code: "capture-not-ready", message: "页面视频取景提交失败", status: statusOf(state) };
      }
      state.frozenVideo = decision.frozen;
      state.frozen = undefined;
      state.phase = "ready";
      state.stale = false;
      state.reason = undefined;
      state.width = decision.frozen.media.width;
      state.height = decision.frozen.media.height;
      state.observation = observation;
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
