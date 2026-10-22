import { afterEach, expect, it } from "vitest";
import { installInteractionController } from "./interaction-controller.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { canvasWith, getSession, harness, installSharedSession, runtimeCapturing } from "./test-support/controller-harness.js";

installSharedSession();
afterEach(() => nodeSelectionStore.reset());

it.each(["context-only", "missing-up", "normal-up", "pan", "cancel"])(
  "handles WebKit secondary input without duplicate or revived menus: %s", mode => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const dom = harness();
    const { runtime } = runtimeCapturing();
    const opened: unknown[] = [];
    const controller = installInteractionController({
      canvas: dom.canvas, target: dom.target as never,
      getRuntime: () => runtime, getSession: () => getSession() as never,
      onContextMenu: request => opened.push(request)
    });
    const event = { button: 2, clientX: 400, clientY: 300 };
    if (mode !== "context-only") dom.fire("pointerdown", event);
    if (mode === "normal-up") dom.fire("pointerup", event);
    if (mode === "pan") dom.fire("pointermove", { ...event, clientX: 450 });
    if (mode === "cancel") dom.fire("pointercancel", event);
    dom.fire("contextmenu", event);
    if (mode === "missing-up" || mode === "pan") dom.fire("pointerup", event);
    expect(opened).toHaveLength(mode === "pan" || mode === "cancel" ? 0 : 1);
    if (opened.length) expect(opened[0]).toMatchObject({ screen: { x: 400, y: 300 }, node: null });
    controller.dispose();
  }
);
