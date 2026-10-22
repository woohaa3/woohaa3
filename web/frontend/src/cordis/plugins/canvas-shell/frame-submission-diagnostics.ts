/** Fixed vocabulary; never retain node IDs, content, or caller-provided reason text. */
export const FULL_SCENE_REASONS = ["forced", "no-baseline", "runtime-unavailable", "index-unavailable", "runtime-changed", "index-changed", "generation-changed", "base-changed", "render-issues", "surface-changed", "baseline-focus", "focus-active", "local-sizes", "marquee", "transient-changed", "dirty-reasons", "positions-unavailable", "position-plan-unavailable", "incremental"] as const;
export type FullSceneReason = typeof FULL_SCENE_REASONS[number];
export const DIRTY_REASONS = ["viewport", "viewport-transition", "position-preview", "input", "start", "invalidate", "canvas-store", "theme", "film-set-media", "model-scenes", "image-resources", "video-frames", "image-focus-texture", "video-focus-texture", "focus-content-rect", "image-focus", "video-focus", "focus-transition", "model-scene-override", "model-focus-targets", "model-editor", "animation-playback", "ghost-nodes", "preview-urls", "model-focus", "model-preview", "other"] as const;
export type SubmissionDiagnostic = {
  sequence: number; startedAt: number; totalMs: number;
  route: "full" | "viewport" | "positions" | "observer" | "dedupe" | "noop";
  reason: FullSceneReason; dirtyReasons: string[];
  outcome: "ok" | "error" | "skipped" | "queued";
  nodes: number; edges: number; sceneJsonCodeUnits: number;
  buildMs: number; fingerprintMs: number; stringifyMs: number; acceptMs: number;
  baseGeneration: number; acceptedGeneration: number;
};
let sequence = 0;
const recent: SubmissionDiagnostic[] = [];
export const submissionDiagnosticsEnabled = () => import.meta.env.DEV && import.meta.env.VITE_WOOHAA_PERFORMANCE !== "0";
export function recordSubmission(value: Omit<SubmissionDiagnostic, "sequence">) {
  if (!submissionDiagnosticsEnabled()) return;
  recent.push({ ...value, sequence: ++sequence });
  if (recent.length > 64) recent.shift();
}
export function submissionSequence() { return sequence; }
export function submissionsSince(start: number) {
  const entries = recent.filter(value => value.sequence > start).slice(-8);
  return { entries, omitted: Math.max(0, sequence - start - entries.length) };
}
