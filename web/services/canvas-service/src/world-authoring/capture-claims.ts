/**
 * Trusted claim ledger for T10 generation acceptance.
 *
 * Only a freeze that passed key equality and media verification can create a claim.
 * `/runs` validates the exact request/key/media identity again immediately before its
 * durable begin transaction and reuses the same claim for idempotent retries.
 */
import {
  worldCaptureDynamicBaseKey,
  toWorldCaptureInput,
  worldCaptureVersionKeysEqual,
  worldCaptureVideoBinding,
  type WorldCaptureFreezeOutcome,
  type WorldCaptureGenerationBinding
} from "@woohaa3/contracts";
import type { CameraObservation } from "./capture-snapshot.js";
import type {
  Claim,
  FramingState,
  WorldCaptureClaimInput,
  WorldCaptureClaimResult
} from "./capture-service-types.js";

function mediaIdentityEqual(
  left: WorldCaptureGenerationBinding["media"],
  right: WorldCaptureGenerationBinding["media"]
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return (
    left.mediaId === right.mediaId &&
    left.storageKey === right.storageKey &&
    left.checksum === right.checksum &&
    left.contentType === right.contentType &&
    left.size === right.size &&
    left.width === right.width &&
    left.height === right.height
  );
}

function videoIdentityEqual(
  left: WorldCaptureGenerationBinding["video"],
  right: WorldCaptureGenerationBinding["video"]
): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return (
    left.mediaId === right.mediaId &&
    left.storageKey === right.storageKey &&
    left.checksum === right.checksum &&
    left.contentType === right.contentType &&
    left.size === right.size &&
    left.width === right.width &&
    left.height === right.height &&
    left.durationSeconds === right.durationSeconds &&
    left.fps === right.fps &&
    left.container === right.container
  );
}

function frozenMediaOf(state: FramingState): {
  mediaId: string;
  checksum: string;
} | null {
  if (state.frozenVideo) {
    return { mediaId: state.frozenVideo.media.mediaId, checksum: state.frozenVideo.media.checksum };
  }
  if (state.frozen) {
    return { mediaId: state.frozen.media.mediaId, checksum: state.frozen.media.checksum };
  }
  return null;
}

export type CaptureClaimLedger = {
  claim(state: FramingState, observation: CameraObservation, requestId: string): WorldCaptureFreezeOutcome;
  claimForGeneration(input: WorldCaptureClaimInput): WorldCaptureClaimResult;
  forgetCanvas(canvasId: string): void;
  clear(): void;
};

export function createCaptureClaimLedger(options: {
  now: () => number;
  claimTtlMs: number;
}): CaptureClaimLedger {
  const claims = new Map<string, Claim>();

  function claim(
    state: FramingState,
    observation: CameraObservation,
    requestId: string
  ): WorldCaptureFreezeOutcome {
    const frozenMedia = frozenMediaOf(state);
    const baseKey = observation.kind === "dynamic"
      ? worldCaptureDynamicBaseKey(observation.key)
      : observation.key;
    if (!frozenMedia || state.stale || !state.key || !worldCaptureVersionKeysEqual(state.key, baseKey)) {
      return { ok: false, code: "capture-not-ready", message: "当前取景尚未获得有效媒体" };
    }
    const existing = claims.get(requestId);
    if (existing) {
      if (
        existing.binding.key.canvasId !== observation.canvasId ||
        !worldCaptureVersionKeysEqual(existing.binding.key, baseKey) ||
        existing.binding.input.checksum !== frozenMedia.checksum ||
        existing.binding.input.mediaId !== frozenMedia.mediaId
      ) {
        return { ok: false, code: "request-conflict", message: "相同请求身份使用了不同取景版本" };
      }
      return { ok: true, binding: existing.binding };
    }
    let binding: WorldCaptureGenerationBinding;
    if (observation.kind === "dynamic") {
      if (!state.frozenVideo) {
        return { ok: false, code: "capture-not-ready", message: "当前取景尚未获得有效视频媒体" };
      }
      binding = worldCaptureVideoBinding(
        requestId,
        observation.request.contentFingerprint,
        state.frozenVideo
      );
    } else {
      if (!state.frozen) {
        return { ok: false, code: "capture-not-ready", message: "当前取景尚未获得有效媒体" };
      }
      binding = {
        version: "world-capture-generation-binding-v2",
        requestId,
        key: observation.key,
        contentFingerprint: observation.request.contentFingerprint,
        input: toWorldCaptureInput(state.frozen),
        media: state.frozen.media
      };
    }
    claims.set(requestId, { binding, createdAt: options.now() });
    return { ok: true, binding };
  }

  return {
    claim,

    claimForGeneration({ canvasId, requestId, binding }) {
      const existing = claims.get(requestId);
      if (!existing) return { ok: false, code: "unknown-capture", message: "未找到该次取景冻结结果" };
      if (existing.binding.key.canvasId !== canvasId) {
        return { ok: false, code: "capture-mismatch", message: "取景冻结不属于当前画布" };
      }
      if (options.now() - existing.createdAt > options.claimTtlMs) {
        claims.delete(requestId);
        return { ok: false, code: "capture-expired", message: "取景冻结结果已过期，请重新生成" };
      }
      if (
        binding.version !== existing.binding.version ||
        binding.requestId !== existing.binding.requestId ||
        !worldCaptureVersionKeysEqual(binding.key, existing.binding.key) ||
        !worldCaptureVersionKeysEqual(binding.input.key, existing.binding.input.key) ||
        binding.input.mediaId !== existing.binding.input.mediaId ||
        binding.input.checksum !== existing.binding.input.checksum ||
        binding.contentFingerprint !== existing.binding.contentFingerprint ||
        !mediaIdentityEqual(binding.media, existing.binding.media) ||
        !videoIdentityEqual(binding.video, existing.binding.video)
      ) {
        return { ok: false, code: "capture-mismatch", message: "取景冻结输入与受理记录不一致" };
      }
      return { ok: true, binding: existing.binding };
    },

    forgetCanvas(canvasId) {
      for (const [requestId, claimValue] of claims) {
        if (claimValue.binding.key.canvasId === canvasId) claims.delete(requestId);
      }
    },

    clear() {
      claims.clear();
    }
  };
}
