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
  const baselineBlock = (runtime: BevyRuntime, index: CanvasNodeIndex | null): string | null => {
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

  const presentationRows = (index: CanvasNodeIndex, next: Map2D) => {
    const accepted = baseline;
    if (!accepted) return [];
    return changedPreviewPositions(index, accepted.previews, next).filter(position => mirror.node(accepted.scene, position.id)).map(position => {
      const node = mirror.node(accepted.scene, position.id);
      const previous = accepted.previews.get(position.id) ?? index.absolutePosition(position.id);
      if (!node || !previous) throw new Error("Unknown presentation position node");
      // Adapters may expand a node around its canonical center. Move its accepted
      // presentation by the gesture delta instead of replacing that offset.
      return { id: position.id, x: node.x + position.x - previous.x, y: node.y + position.y - previous.y };
    });
  };

  const submit = (reasons: ReadonlySet<string>, force: boolean): Outcome => {
    const runtime=deps.options.getRuntime();
    const index=indexNow();
    const onlyPositions=!force && reasons.has("position-preview")
      && [...reasons].every(r=>r==="position-preview" || r==="viewport" || r==="viewport-transition");
    const block = runtime && index ? baselineBlock(runtime, index) : runtime ? "index-unavailable" : "runtime-unavailable";
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
        noteSceneSubmitRoute("observer", reasons);
        try {
          runtime.setObserver(input);
          baseline.scene = applyObserverToScene(baseline.scene, input);
          fingerprint = null;
          deps.options.onScene?.(baseline.scene);
          deps.options.onSceneSubmitted?.();
          return {error:null,retry:false};
        } catch (error) { return fail(error); }
      }
    }
    if (runtime && index && !block && baseline) {
      if (onlyPositions && runtime.setPositions) {
        const next=expandPositionPreviews(index,deps.state.localPositions);
        if (next) {
          try {
            const positions=presentationRows(index,next);
            const viewport=deps.viewport(),old=baseline.scene.viewport;
            const viewChanged=viewport.x!==old.x || viewport.y!==old.y || viewport.zoom!==old.zoom;
            if (positions.length) {
              const input={baseSceneGeneration:baseline.base,positions,...(viewChanged ? {viewport} : {})};
              noteSceneSubmitRoute("positions", reasons);
              runtime.setPositions(input);
              baseline.scene=mirror.apply(baseline.scene,input);
              baseline.previews=next;
              fingerprint=null;
              deps.options.onScene?.(baseline.scene);
              deps.options.onSceneSubmitted?.();
              return {error:null,retry:false};
            }
            if (!viewChanged) return {error:null,retry:false};
            // No moved rows: a combined frame reduces to the one viewport call.
            noteSceneSubmitRoute("viewport", reasons);
            const error=commitViewportUpdate(runtime,viewport);
            if (error) return fail(error);
            baseline.scene={...baseline.scene,viewport:{...viewport}};
            deps.options.onSceneSubmitted?.();
            return {error:null,retry:false};
          } catch (error) { return fail(error); }
        }
      }
      if (shouldRouteViewportOnly(reasons,force)) {
        const viewport=deps.viewport();
        noteSceneSubmitRoute("viewport", reasons);
        const error=commitViewportUpdate(runtime,viewport);
        if (error) return fail(error);
        baseline.scene={...baseline.scene,viewport:{...viewport}};
        deps.options.onSceneSubmitted?.();
        return {error:null,retry:false};
      }
    }
    const built = deps.build();
    if (!built || !runtime) return {error:null,retry:false};
    sceneDiagnostics.fingerprintBuilds+=1;
    const nextFingerprint = renderSceneFingerprint(built.scene);
    // Runtime/source identity changes require replay even for identical wire data.
    const sameRuntime=baseline?.runtime===runtime && baseline.generation===(runtime.generation?.() ?? 0)
      && baseline.base===runtime.baseSceneGeneration?.();
    if (fingerprint===nextFingerprint && sameRuntime && !runtime.getRenderIssues?.().length) {
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
      deps.options.onSceneSubmitted?.();
      return {error:null,retry:false};
    } catch(error) { return fail(error); }
  };

  const run = (reasons: ReadonlySet<string>, force: boolean): Outcome => submit(reasons, force);

  /** Active Q/E contacts reuse rendered dimensions; no resources or full rebuild. */
  const dragScene = (): CanvasRenderScene | null => {
    const index=indexNow();
    if (!baseline || !index || baseline.index!==index) return deps.build()?.scene ?? null;
    const positions=expandPositionPreviews(index,deps.state.localPositions);
    if (!positions) return null;
    const rows=presentationRows(index,positions);
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
