import { describe, expect, it, vi } from "vitest";
import { installCanvasRuntimeMirrors } from "./canvas-runtime-mirrors.js";

describe("canvas runtime diagnostics", () => {
  it("exposes the overview snapshot and controlled comparison switch", () => {
    const setBenchmarkDisabled = vi.fn();
    installCanvasRuntimeMirrors({
      videoSessions: { activeNodeIds: () => [], playingNodeId: () => null, hasRealFrame: () => false },
      modelFocus: () => null, imageFocus: () => null, videoFocus: () => null, videoFocusTargetId: () => null,
      overviewCache: { diagnostics: () => ({ refreshes: 2 }), setBenchmarkDisabled }
    });
    const mirror = (globalThis as unknown as { __canvasOverviewCache: { snapshot: () => unknown; setBenchmarkDisabled: (value: boolean) => void } }).__canvasOverviewCache;
    expect(mirror.snapshot()).toEqual({ refreshes: 2 });
    mirror.setBenchmarkDisabled(true);
    expect(setBenchmarkDisabled).toHaveBeenCalledWith(true);
  });
});
