import { afterEach, expect, it, vi } from "vitest";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { installInteractionController } from "./interaction-controller.js";
import { setNodeActionBridge } from "./node-action-bridge.js";
import { canvasWith, getSession, harness, installSharedSession, runtimeCapturing } from "./test-support/controller-harness.js";

installSharedSession();
afterEach(() => nodeSelectionStore.reset());

it("keeps action data in Web and anchors the DOM toolbar to accepted card drag positions", () => {
  const canvas = canvasWith([{ id: "a", x: 100, y: 150 }]);
  canvas.document.nodes.push({ id: "world", type: "model3d", position: { x: 600, y: 150 } });
  canvas.nodeData.world = { sharedWorldInstance: {
    kind: "world-instance", version: "shared-world-v1", instanceId: "world-instance",
    transform: { version: "shared-world-v1", position: { u: 2, v: 3, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 }
  } };
  canvas.document.nodes.push({ id: "area", type: "scene-area", position: { x: 0, y: 0 } });
  canvas.nodeData.area = { sceneArea: { kind: "scene-area", version: "shared-world-v1", areaId: "area", scopeVersion: "v1",
    bounds: { min: { u: 0, v: 0 }, max: { u: 4, v: 6 } } } };
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  const describe = vi.fn(() => new Map([["a", { actions: [{ id: "edit", label: "编辑", enabled: true }] }]]));
  const removeBridge = setNodeActionBridge({ toolbars: describe, activate: vi.fn() });
  const dom = harness();
  const { runtime, scenes } = runtimeCapturing();
  const controller = installInteractionController({ canvas: dom.canvas, getRuntime: () => runtime,
    getSession: () => getSession() as never, target: dom.target as never });
  try {
    controller.selectNode("a"); controller.flush();
    expect(controller.nodeScreenRect("a", "action-toolbar")).toMatchObject({ left: 100, top: 150 });
    dom.fire("pointerdown", { clientX: 180, clientY: 230 });
    dom.fire("pointermove", { clientX: 280, clientY: 330 });
    controller.flush();
    expect(controller.nodeScreenRect("a", "action-toolbar")).toMatchObject({ left: 200, top: 250 });
    expect(scenes.length).toBeGreaterThan(0);
    expect(scenes.every(scene => !("nodeActions" in scene))).toBe(true);
    expect(describe).not.toHaveBeenCalled();
    expect(controller.nodeScreenRect("missing", "action-toolbar")).toBeNull();
    // World models now anchor the Web toolbar to their actual world projection.
    expect(controller.nodeScreenRect("world", "action-toolbar")).not.toBeNull();
    expect((scenes.at(-1)! as { nodes: Array<{ id: string }> }).nodes.some(node => node.id === "area")).toBe(false);
    expect(controller.nodeScreenRect("area", "action-toolbar")).not.toBeNull();
  } finally { controller.dispose(); removeBridge(); }
});
