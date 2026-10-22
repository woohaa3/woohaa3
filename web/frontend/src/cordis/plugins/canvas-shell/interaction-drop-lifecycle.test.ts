import { afterEach, expect, it, vi } from "vitest";
import { installInteractionController } from "./interaction-controller.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeDrop } from "../../services/node-drop/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { canvasWith, getSession, harness, installSharedSession, runtimeCapturing, submitted } from "./test-support/controller-harness.js";

installSharedSession();
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); nodeSelectionStore.reset(); });

it.each(["pointercancel", "blur", "visibilitychange", "Escape", "modal", "dispose", "owner-deleted"])(
  "%s clears drop feedback and prevents a late release commit", reason => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "source", x: 0, y: 0 }]));
    const dom = harness();
    const { runtime } = runtimeCapturing();
    const preview = vi.fn();
    const unbind = nodeDrop.bind({ preview, drop: () => false });
    const controller = installInteractionController({ canvas: dom.canvas, target: dom.target as never,
      getRuntime: () => runtime, getSession: () => getSession() as never });
    cleanups.push(() => { controller.dispose(); unbind(); });
    dom.fire("pointerdown", { clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 140, clientY: 130 });
    controller.flush();
    expect(preview.mock.calls.some(([drag]) => drag?.sourceNodeIds.includes("source"))).toBe(true);
    if (reason === "Escape") dom.fireKey("keydown", { key: "Escape", code: "Escape" });
    else if (reason === "modal") controller.cancelTransientGesture();
    else if (reason === "dispose") controller.dispose();
    else if (reason === "owner-deleted") woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([]));
    else dom.fire(reason, {});
    controller.flush();
    expect(preview.mock.calls.at(-1)?.[0]).toBeNull();
    dom.fire("pointerup", { clientX: 140, clientY: 130 });
    controller.flush();
    expect(submitted).toHaveLength(0);
    expect(preview.mock.calls.at(-1)?.[0]).toBeNull();
  }
);
