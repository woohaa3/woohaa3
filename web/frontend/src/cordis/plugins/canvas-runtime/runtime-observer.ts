import { applyObserverToScene, canvasObserverUpdateRequest, type CanvasRenderScene } from "@woohaa3/contracts";
import type { BevyModule, BevyRuntime } from "./bevy-runtime-types.js";
import { measureSceneWork, sceneDiagnostics } from "./scene-diagnostics.js";

type Input = Parameters<NonNullable<BevyRuntime["setObserver"]>>[0];

/** Optional focused-orbit increment; missing WASM export leaves `setObserver` undefined. */
export function createRuntimeObserver(deps: {
  module: () => BevyModule;
  now: () => number;
  lastScene: () => CanvasRenderScene | null;
  accepted(scene: CanvasRenderScene | null, generation: number): void;
}): Pick<BevyRuntime, "setObserver"> {
  if (!deps.module().set_observer) return {};
  return {
    setObserver(input: Input) {
      const module = deps.module();
      if (!module.set_observer) throw new Error("Bevy 运行时缺少 set_observer 边界");
      const json = measureSceneWork("stringifyMs", deps.now, () => canvasObserverUpdateRequest(input));
      sceneDiagnostics.observerSubmits++;
      sceneDiagnostics.boundaryBytes += json.length;
      const generation = measureSceneWork("wasmAcceptMs", deps.now, () => module.set_observer!(json));
      const last = deps.lastScene();
      deps.accepted(last ? applyObserverToScene(last, input) : last, generation);
      return generation;
    }
  };
}
