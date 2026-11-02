/**
 * Freeze wait loop for one exact capture key.
 *
 * Polling is intentional and bounded: state transitions are driven by producer/media
 * promises, while key replacement and cancellation must win immediately. A changed key
 * never retargets the wait.
 */
import { worldCaptureVersionKeysEqual, type WorldCaptureVersionKey } from "@woohaa3/contracts";
import type { FramingState } from "./capture-service-types.js";

export type FreezeWaitResult =
  | "ready"
  | "cancelled"
  | "superseded"
  | "capture-not-ready"
  | "capture-unavailable"
  | "timeout";

export async function waitForFreeze(
  state: FramingState,
  targetKey: WorldCaptureVersionKey,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<FreezeWaitResult> {
  // Wait budgets use the wall clock; an injected fixed clock is only for persisted
  // timestamps and must not freeze the timeout.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) return "cancelled";
    if (!state.key || !worldCaptureVersionKeysEqual(state.key, targetKey)) return "superseded";
    if (state.phase === "ready" && !state.stale && state.frozen) return "ready";
    if (state.phase === "failed") return "capture-not-ready";
    if (state.phase === "unavailable") return "capture-unavailable";
    if (state.phase === "cancelled") return "cancelled";
    if (Date.now() >= deadline) return "timeout";
    const attempt = state.attempt;
    const remaining = Math.max(1, deadline - Date.now());
    await Promise.race([
      attempt?.promise ?? Promise.resolve(),
      delay(Math.min(100, remaining))
    ]);
    if (!state.attempt) await delay(0);
  }
}

export function freezeMessage(code: string): string {
  switch (code) {
    case "cancelled": return "取景等待已取消";
    case "superseded": return "该版本取景已被新版本替换，请重新生成";
    case "capture-not-ready": return "当前取景尚未获得有效媒体";
    case "capture-unavailable": return "当前没有可用的取景渲染生产者";
    case "timeout": return "等待有效取景超时";
    default: return "取景尚未就绪";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
