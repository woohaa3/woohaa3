/**
 * Trusted claim ledger for T10 generation acceptance.
 *
 * Only a freeze that passed key equality and media verification can create a claim.
 * `/runs` validates the exact request/key/media identity again immediately before its
 * durable begin transaction and reuses the same claim for idempotent retries.
 */
import {
  toWorldCaptureInput,
  worldCaptureVersionKeysEqual,
  type WorldCaptureFreezeOutcome,
  type WorldCaptureGenerationBinding
} from "@woohaa3/contracts";
import type { Observation } from "./capture-snapshot.js";
import type {
  Claim,
  FramingState,
  WorldCaptureClaimInput,
  WorldCaptureClaimResult
} from "./capture-service-types.js";

export type CaptureClaimLedger = {
  claim(state: FramingState, observation: Observation, requestId: string): WorldCaptureFreezeOutcome;
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
    observation: Observation,
    requestId: string
  ): WorldCaptureFreezeOutcome {
    if (!state.frozen || state.stale || !state.key || !worldCaptureVersionKeysEqual(state.key, observation.key)) {
      return { ok: false, code: "capture-not-ready", message: "当前取景尚未获得有效媒体" };
    }
    const existing = claims.get(requestId);
    if (existing) {
      if (
        existing.binding.key.canvasId !== observation.canvasId ||
        !worldCaptureVersionKeysEqual(existing.binding.key, observation.key) ||
        existing.binding.input.checksum !== state.frozen.media.checksum ||
        existing.binding.input.mediaId !== state.frozen.media.mediaId
      ) {
        return { ok: false, code: "request-conflict", message: "相同请求身份使用了不同取景版本" };
      }
      return { ok: true, binding: existing.binding };
    }
    const binding: WorldCaptureGenerationBinding = {
      version: "world-capture-generation-binding-v1",
      requestId,
      key: observation.key,
      contentFingerprint: observation.request.contentFingerprint,
      input: toWorldCaptureInput(state.frozen)
    };
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
        binding.contentFingerprint !== existing.binding.contentFingerprint
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
