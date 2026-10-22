import { canvasViewportUpdateRequest } from "@woohaa3/contracts";
import type { BevyModule, BevyRuntime } from "./bevy-runtime-types.js";
import { measureSceneWork, sceneDiagnostics } from "./scene-diagnostics.js";

type Input = Parameters<NonNullable<BevyRuntime["setViewport"]>>[0];
export function createRuntimeViewport(deps: {
  module: () => BevyModule; now: () => number;
  accepted(input: Input, generation: number): void;
}) {
  const encode = (input: Input) => {
    const json = measureSceneWork("stringifyMs", deps.now, () => canvasViewportUpdateRequest(input));
    sceneDiagnostics.viewportSubmits++; sceneDiagnostics.boundaryBytes += json.length;
    return json;
  };
  return {
    setViewport(input: Input) {
      const module = deps.module();
      if (!module.set_viewport) throw new Error("Bevy 运行时缺少 set_viewport 边界");
      const json = encode(input);
      const generation = measureSceneWork("wasmAcceptMs", deps.now, () => module.set_viewport!(json));
      deps.accepted(input, generation); return generation;
    },
    ...(deps.module().queue_viewport ? { queueViewport(input: Input) {
      // 异步排队不更新 interaction generation，也不计作同步接受耗时。
      const snapshot = { ...input, viewport: { ...input.viewport } };
      const json = encode(snapshot);
      deps.module().queue_viewport!(json, generation => deps.accepted(snapshot, generation));
    } } : {})
  };
}
