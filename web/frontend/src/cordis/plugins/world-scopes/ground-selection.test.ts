import { expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { installInteractionController } from "../canvas-shell/interaction-controller.js";
import { getSession, harness, installSharedSession, runtimeCapturing } from "../canvas-shell/test-support/controller-harness.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";

installSharedSession();

it("projects canonical bounds and cycles overlapping ground selections independently of card positions", () => {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  const area = (areaId: string, min: number, max: number) => ({ kind: "scene-area", version: "shared-world-v1", areaId, scopeVersion: "v1", bounds: { min: { u: min, v: min }, max: { u: max, v: max } } });
  woohaa3CanvasStore.getState().applyRemoteCanvas({ ...base, revision: 1,
    document: { ...base.document, nodes: [{ id: "b", type: "group", position: { x: 1000, y: 1000 } }, { id: "a", type: "group", position: { x: -1000, y: -1000 } }] },
    nodeData: { a: { sceneArea: area("a", 0, 3) }, b: { sceneArea: area("b", 1, 4) } }
  } as ServerCanvas);
  const dom = harness();
  const { runtime, scenes } = runtimeCapturing({ pointHit: () => null });
  runtime.queryWorldGround = () => ({ ok: true, generation: 1, value: { u: 2, v: 2 } });
  const controller = installInteractionController({ canvas: dom.canvas, getRuntime: () => runtime, getSession: () => getSession() as never, target: dom.target as never });
  controller.flush();
  expect((scenes.at(-1) as unknown as { sceneAreas: unknown[] }).sceneAreas).toHaveLength(2);
  dom.fire("pointerdown", { clientX: 10, clientY: 10, button: 0 });
  dom.fire("pointerup", { clientX: 10, clientY: 10, button: 0 });
  expect(nodeSelectionStore.getPrimaryNodeId()).toBe("a");
  controller.flush();
  dom.fire("pointerdown", { clientX: 10, clientY: 10, button: 0 });
  dom.fire("pointerup", { clientX: 10, clientY: 10, button: 0 });
  expect(nodeSelectionStore.getPrimaryNodeId()).toBe("b");
  dom.fire("pointerdown", { clientX: 10, clientY: 10, button: 0 });
  dom.fire("pointermove", { clientX: 40, clientY: 40, button: 0 });
  controller.flush();
  expect((scenes.at(-1) as unknown as { marquee: unknown }).marquee).toBeTruthy();
  dom.fire("pointerup", { clientX: 40, clientY: 40, button: 0 });
  expect(nodeSelectionStore.getPrimaryNodeId()).not.toBe("a");
  controller.dispose();
});
