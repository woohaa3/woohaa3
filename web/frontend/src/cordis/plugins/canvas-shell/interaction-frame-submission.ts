import { recordStartupFrame } from "../canvas-runtime/startup-trace.js";
import { DIRTY_REASONS, recordSubmission, submissionDiagnosticsEnabled, type FullSceneReason, type SubmissionDiagnostic } from "./frame-submission-diagnostics.js";
import { applyObserverToScene, renderSceneFingerprint, type CanvasRenderScene, type PreparedModelResource } from "@woohaa3/contracts";
import { noteSceneSubmitRoute, sceneDiagnostics } from "../canvas-runtime/scene-diagnostics.js";
import { PositionSceneMirror } from "../canvas-runtime/position-scene-mirror.js";
import type { BevyRuntime } from "../canvas-runtime/bevy-runtime.js";
import { sharedCanvasNodeIndex, type CanvasNodeIndex } from "./canvas-node-index.js";
import { changedPreviewPositions, expandPositionPreviews } from "./position-preview-plan.js";
import { shouldRouteViewportOnly, shouldRouteObserverOnly, commitViewportUpdate } from "./interaction-frame-plan.js";
import { workingCanvasOf, woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { modelPreviewStore } from "../../services/model-preview-store.js";
import type { InteractionState, Map2D, Viewport } from "./interaction-core.js";
import type { InteractionControllerOptions } from "./interaction-types.js";

type Baseline = {
  runtime: BevyRuntime; generation: number; base: number; index: CanvasNodeIndex;
  scene: CanvasRenderScene; previews: Map2D; transient: string;
};
type Outcome = { error: string | null; retry: boolean };

/** The controller's sole frame submission owner: full, viewport, positions or observer. */
export function createFrameSubmission(deps: {
  options: InteractionControllerOptions; state: InteractionState;
  now?: () => number;
  viewport: () => Viewport;
  surface: () => {width:number;height:number;pixelRatio:number;originX?:number;originY?:number};
  transient: () => {dragAttach: CanvasRenderScene["dragAttach"] | null; aggregateConnect: CanvasRenderScene["aggregateConnect"] | null};
  build: () => {scene:CanvasRenderScene;resources:Map<string,PreparedModelResource>} | null;
}) {
  let baseline: Baseline | null = null;
  let fingerprint: string | null = null;
  const mirror = new PositionSceneMirror();
  const indexNow = () => sharedCanvasNodeIndex(workingCanvasOf(woohaa3CanvasStore.getState()));
  const transientNow = () => JSON.stringify({
    ...deps.transient(), selected:deps.state.selected, draft:deps.state.draft,
    hover:[deps.state.hoveredNodeId,deps.state.hoveredPort,deps.state.hoveredEdgeId]
  });
  let trace: Omit<SubmissionDiagnostic, "sequence"> | undefined;
  const now = deps.now ?? (() => performance.now());
  const baselineBlock = (runtime: BevyRuntime, index: CanvasNodeIndex | null): FullSceneReason | null => {
    if (!baseline) return "no-baseline";
    if (baseline.runtime !== runtime) return "runtime-changed";
    if (baseline.index !== index) return "index-changed";
    if (baseline.generation !== (runtime.generation?.() ?? 0)) return "generation-changed";
    if (baseline.base !== runtime.baseSceneGeneration?.()) return "base-changed";
    if (runtime.getRenderIssues?.().length) return "render-issues";
    const surface = deps.surface(), previous = baseline.scene.surface;
    if (!previous || surface.width !== previous.width || surface.height !== previous.height || surface.pixelRatio !== previous.pixelRatio || (surface.originX ?? 0) !== (previous.originX ?? 0) || (surface.originY ?? 0) !== (previous.originY ?? 0)) return "surface-changed";
    if (baseline.scene.modelFocus || baseline.scene.modelEditor || baseline.scene.imageFocus || baseline.scene.videoFocus) return "baseline-focus";
    if (deps.options.getModelFocus?.() || deps.options.getModelEditor?.() || deps.options.getImageFocus?.() || deps.options.getVideoFocus?.()) return "focus-active";
    if (deps.state.localSizes.size) return "local-sizes";
    if (deps.state.gesture.kind === "marquee") return "marquee";
    if (baseline.transient !== transientNow()) return "transient-changed";
    return null;
  };
  const fail = (error: unknown): Outcome => {
    // An incremental rejection invalidates dedupe, even when recovery equals the
    // old full fingerprint (e.g. cancel or WASM restart).
    fingerprint=null; baseline=null;
    return {error:error instanceof Error ? error.message : String(error),retry:true};
  };

  const submit = (reasons: ReadonlySet<string>, force: boolean): Outcome => {
    const runtime=deps.options.getRuntime();
    const index=indexNow();
    const onlyPositions=!force && reasons.has("position-preview")
      && [...reasons].every(r=>r==="position-preview" || r==="viewport" || r==="viewport-transition");
    const block = runtime && index ? baselineBlock(runtime, index) : runtime ? "index-unavailable" : "runtime-unavailable";
    if (trace) trace.reason = force ? "forced" : block ?? "dirty-reasons";
    const editorUnchanged = JSON.stringify(baseline?.scene.modelEditor ?? null)
      === JSON.stringify(deps.options.getModelEditor?.() ?? null);
    if (runtime && index && baseline && runtime.setObserver && runtime.baseSceneGeneration?.()
      && shouldRouteObserverOnly(reasons, force, block, !!(baseline.scene.modelFocus && deps.options.getModelFocus?.()), editorUnchanged)) {
      const focus = deps.options.getModelFocus!();
      if (focus && baseline.scene.modelFocus?.nodeId === focus.nodeId) {
        const input = {
          baseSceneGeneration: runtime.baseSceneGeneration(),
          nodeId: focus.nodeId,
          preview: modelPreviewStore.get(focus.nodeId),
          yaw: focus.yaw, pitch: focus.pitch, distance: focus.distance, target: focus.target
        };
        if (trace) { trace.route = "observer"; trace.reason = "incremental"; }
        noteSceneSubmitRoute("observer", reasons);
        try {
          runtime.setObserver(input);
          baseline.scene = applyObserverToScene(baseline.scene, input);
          fingerprint = null;
          deps.options.onScene?.(baseline.scene);
          return {error:null,retry:false};
        } catch (error) { return fail(error); }
      }
    }
    if (runtime && index && !block && baseline) {
      if (onlyPositions && runtime.setPositions) {
        const next=expandPositionPreviews(index,deps.state.localPositions);
        if (next) {
          try {
            const positions=changedPreviewPositions(index,baseline.previews,next);
            const viewport=deps.viewport(),old=baseline.scene.viewport;
            const viewChanged=viewport.x!==old.x || viewport.y!==old.y || viewport.zoom!==old.zoom;
            if (positions.length) {
              const input={baseSceneGeneration:baseline.base,positions,...(viewChanged ? {viewport} : {})};
              if (trace) { trace.route = "positions"; trace.reason = "incremental"; }
              noteSceneSubmitRoute("positions", reasons);
              runtime.setPositions(input);
              baseline.scene=mirror.apply(baseline.scene,input);
              baseline.previews=next;
              fingerprint=null;
              deps.options.onScene?.(baseline.scene);
              return {error:null,retry:false};
            }
            if (!viewChanged) { if (trace) trace.route = "noop"; return {error:null,retry:false}; }
            // No moved rows: a combined frame reduces to the one viewport call.
            if (trace) { trace.route = "viewport"; trace.reason = "incremental"; }
            noteSceneSubmitRoute("viewport", reasons);
            const error=commitViewportUpdate(runtime,viewport);
            if (error) return fail(error);
            if (trace && runtime.queueViewport) trace.outcome = "queued";
            baseline.scene={...baseline.scene,viewport:{...viewport}};
            return {error:null,retry:false};
          } catch (error) { return fail(error); }
        }
      }
      if (onlyPositions && trace) trace.reason = runtime.setPositions ? "position-plan-unavailable" : "positions-unavailable";
      if (shouldRouteViewportOnly(reasons,force)) {
        const viewport=deps.viewport();
        if (trace) { trace.route = "viewport"; trace.reason = "incremental"; }
        noteSceneSubmitRoute("viewport", reasons);
        const error=commitViewportUpdate(runtime,viewport);
        if (error) return fail(error);
        if (trace && runtime.queueViewport) trace.outcome = "queued";
        baseline.scene={...baseline.scene,viewport:{...viewport}};
        return {error:null,retry:false};
      }
    }
    const measure = <T,>(key: "sceneBuildMs" | "fingerprintMs", run: () => T): T => {
      if (!trace) return run();
      const started = now();
      try { return run(); } finally { sceneDiagnostics[key] += Math.max(0, now() - started); }
    };
    const built = measure("sceneBuildMs", deps.build);
    if (!built || !runtime) { if (trace) trace.outcome = "skipped"; return {error:null,retry:false}; }
    if (trace) { trace.nodes = built.scene.nodes.length; trace.edges = built.scene.edges.length; }
    sceneDiagnostics.fingerprintBuilds+=1;
    const nextFingerprint = measure("fingerprintMs", () => renderSceneFingerprint(built.scene));
    // Runtime/source identity changes require replay even for identical wire data.
    const sameRuntime=baseline?.runtime===runtime && baseline.generation===(runtime.generation?.() ?? 0)
      && baseline.base===runtime.baseSceneGeneration?.();
    if (fingerprint===nextFingerprint && sameRuntime && !runtime.getRenderIssues?.().length) {
      if (trace) trace.route = "dedupe";
      noteSceneSubmitRoute("dedupe", reasons);
      sceneDiagnostics.sceneDedupes+=1;
      return {error:null,retry:false};
    }
    deps.options.onScene?.(built.scene);
    try {
      noteSceneSubmitRoute("full", reasons);
      runtime.setScene(built.scene,built.resources);
      fingerprint=nextFingerprint;
      const previews=index && expandPositionPreviews(index,deps.state.localPositions);
      baseline=index && previews ? {runtime,index,previews,scene:mirror.reset(built.scene),
        generation:runtime.generation?.() ?? 0,base:runtime.baseSceneGeneration?.() ?? 0,transient:transientNow()} : null;
      return {error:null,retry:false};
    } catch(error) { return fail(error); }
  };

  let startupKey = "";
  let startupFrames = 0;
  const run = (reasons: ReadonlySet<string>, force: boolean): Outcome => {
    if (!submissionDiagnosticsEnabled()) return submit(reasons, force);
    const started = now();
    const before = { build: sceneDiagnostics.sceneBuildMs, fingerprint: sceneDiagnostics.fingerprintMs,
      stringify: sceneDiagnostics.stringifyMs, accept: sceneDiagnostics.wasmAcceptMs, submits: sceneDiagnostics.sceneSubmits };
    trace = { startedAt: started, totalMs: 0, route: "full", reason: "no-baseline", outcome: "error",
      dirtyReasons: [...new Set([...reasons].map(r => DIRTY_REASONS.includes(r as typeof DIRTY_REASONS[number]) ? r : "other"))],
      nodes: baseline?.scene.nodes.length ?? 0, edges: baseline?.scene.edges.length ?? 0,
      sceneJsonCodeUnits: 0, buildMs: 0, fingerprintMs: 0, stringifyMs: 0, acceptMs: 0,
      baseGeneration: deps.options.getRuntime()?.baseSceneGeneration?.() ?? 0, acceptedGeneration: 0 };
    try {
      const outcome = submit(reasons, force);
      if (outcome.error) trace.outcome = "error";
      else if (trace.outcome !== "skipped" && trace.outcome !== "queued") trace.outcome = "ok";
      return outcome;
    } finally {
      trace.totalMs = Math.max(0, now() - started);
      trace.buildMs = sceneDiagnostics.sceneBuildMs - before.build;
      trace.fingerprintMs = sceneDiagnostics.fingerprintMs - before.fingerprint;
      trace.stringifyMs = sceneDiagnostics.stringifyMs - before.stringify;
      trace.acceptMs = sceneDiagnostics.wasmAcceptMs - before.accept;
      if (trace.route === "full" && sceneDiagnostics.sceneSubmits > before.submits) trace.sceneJsonCodeUnits = sceneDiagnostics.lastSceneJsonCodeUnits;
      trace.acceptedGeneration = deps.options.getRuntime()?.interactionGeneration?.() ?? 0;
      const playback = deps.options.getAnimationPlayback?.();
      if (playback?.playing) {
        const key = JSON.stringify([playback.nodeId, playback.clipId, playback.generation]);
        if (key !== startupKey) { startupKey = key; startupFrames = 0; }
        if (startupFrames++ < 120) recordStartupFrame("scene-frame", {
          nodeId: playback.nodeId, clipId: playback.clipId, generation: playback.generation,
          frame: startupFrames, ...trace
        });
      }
      recordSubmission(trace); trace = undefined;
    }
  };

  /** Active Q/E contacts reuse rendered dimensions; no resources or full rebuild. */
  const dragScene = (): CanvasRenderScene | null => {
    const index=indexNow();
    if (!baseline || !index || baseline.index!==index) return deps.build()?.scene ?? null;
    const positions=expandPositionPreviews(index,deps.state.localPositions);
    if (!positions) return null;
    const rows=changedPreviewPositions(index,baseline.previews,positions);
    const projected=new PositionSceneMirror();
    return projected.apply(projected.reset(baseline.scene),{baseSceneGeneration:baseline.base,positions:rows});
  };
  const renderedNode = (nodeId: string) => {
    const runtime = deps.options.getRuntime();
    if (!baseline || runtime !== baseline.runtime
      || baseline.generation !== (runtime?.generation?.() ?? 0)
      || baseline.base !== (runtime?.baseSceneGeneration?.() ?? 0)) return undefined;
    return mirror.node(baseline.scene, nodeId);
  };
  return {run,dragScene,renderedNode};
}
