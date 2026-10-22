import { describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { createFocusLifecycle } from "./model-focus-lifecycle.js";
import { ModelFocusSession } from "./model-focus-session.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";

describe("focus validity hot path", () => {
  it("checks live resources without constructing targets, and still detects deletion", () => {
    const canvas = createEmptyWoohaa3ServerCanvas("validity");
    canvas.document.nodes.push({ id: "m", type: "model3d", position: { x: 0, y: 0 } });
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
    const focus = new ModelFocusSession();
    focus.enter({ nodeId: "m", target: [0, 0, 0], radius: 1, distance: 5, saved: {} });
    let available = true;
    const getTargets = vi.fn(() => { throw new Error("must not build bounds"); });
    const lifecycle = createFocusLifecycle({
      focus, getTargets, hasTarget: () => available,
      activeViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      surfaceSize: () => ({ width: 100, height: 100, pixelRatio: 1 }),
      localViewportSet: () => {}, emit: () => {}, clearHeld: () => {}, onInvalidate: () => {}
    });
    expect(lifecycle.targetsValid()).toBe(true);
    available = false;
    expect(lifecycle.targetsValid()).toBe(false);
    available = true;
    woohaa3CanvasStore.getState().applyRemoteCanvas({ ...canvas, document: { ...canvas.document, nodes: [] } });
    expect(lifecycle.targetsValid()).toBe(false);
    expect(getTargets).not.toHaveBeenCalled();
  });
});
