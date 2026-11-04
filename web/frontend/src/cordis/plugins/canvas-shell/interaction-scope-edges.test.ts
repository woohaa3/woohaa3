import { afterEach, describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, MIN_NODE_WIDTH, type CanvasRenderScene } from "@woohaa3/contracts";
import { installInteractionController } from "./interaction-controller.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { getSession, harness, installSharedSession, runtimeCapturing, submitted } from "./test-support/controller-harness.js";

installSharedSession();
afterEach(() => nodeSelectionStore.reset());

function setup(writable = true) {
  const source = createEmptyWoohaa3ServerCanvas("c1");
  source.document.nodes.push(
    { id: "g", type: "workflow-group-2d", position: { x: 50, y: 50 }, width: 300, height: 200 },
    { id: "m", type: "image", position: { x: 100, y: 100 }, width: 180, height: 100 }
  );
  source.nodeData.g = { workflowGroup2d: { kind: "workflow-group-2d", version: "shared-world-v1",
    groupId: "g", scopeVersion: "v1", memberNodeIds: ["m"] } };
  woohaa3CanvasStore.getState().applyRemoteCanvas(source);
  const dom = harness();
  const style = { cursor: "" };
  Object.defineProperty(dom.canvas, "style", { value: style });
  const { runtime, scenes } = runtimeCapturing({ pointHit: ({ x, y }) => ({ kind: "node",
    nodeId: x >= 100 && x <= 280 && y >= 100 && y <= 200 ? "m" : "g" }) });
  const controller = installInteractionController({ canvas: dom.canvas, getRuntime: () => runtime,
    getSession: () => getSession() as never, target: dom.target as never, isWritable: () => writable });
  controller.flush();
  submitted.length = 0;
  const fire = (kind: string, x: number, y: number) => dom.fire(kind, { clientX: x, clientY: y });
  const group = () => (scenes.at(-1) as CanvasRenderScene).nodes.find(node => node.id === "g")!;
  return { dom, style, controller, fire, group };
}

describe("group edges resize; title moves", () => {
  it.each([
    [50, 150, "ew-resize", 30, 50, 320, 200],
    [350, 150, "ew-resize", 50, 50, 280, 200],
    [320, 50, "ns-resize", 50, 20, 300, 230],
    [200, 250, "ns-resize", 50, 50, 300, 170],
    [52, 52, "nwse-resize", 30, 20, 320, 230],
    [348, 52, "nesw-resize", 50, 20, 280, 230],
    [52, 248, "nesw-resize", 30, 50, 320, 170],
    [348, 248, "nwse-resize", 50, 50, 280, 170]
  ] as const)("resizes from (%s,%s), using %s", (sx, sy, cursor, x, y, width, height) => {
    const { fire, style, controller, group } = setup();
    fire("pointermove", sx, sy);
    expect(style.cursor).toBe(cursor);
    fire("pointerdown", sx, sy);
    fire("pointermove", sx - 20, sy - 30);
    expect(style.cursor).toBe(cursor);
    expect(group()).toMatchObject({ x, y, width, height });
    // Release may arrive at a new coordinate without a final pointermove.
    fire("pointerup", sx - 20, sy - 30);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ type: "node.update", nodeId: "g", width, height, position: { x, y } });
    expect(group()).toMatchObject({ x, y, width, height });
    expect(woohaa3CanvasStore.getState().canvas?.document.nodes.find(node => node.id === "m")?.position).toEqual({ x: 100, y: 100 });
    controller.dispose();
  });

  it("moves the group and members from either half of its title", () => {
    const { fire, style, controller } = setup();
    fire("pointermove", 150, 54);
    expect(style.cursor).toBe("grab");
    fire("pointerdown", 150, 54);
    fire("pointermove", 170, 84);
    expect(style.cursor).toBe("grabbing");
    fire("pointerup", 170, 84);
    expect(submitted).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "node.update", nodeId: "g", position: { x: 70, y: 80 } }),
      expect.objectContaining({ type: "node.update", nodeId: "m", position: { x: 120, y: 130 } })
    ]));
    controller.dispose();
  });

  it("clamps the left edge while fixing the right edge, and uses release coordinates", () => {
    const { fire, controller, group } = setup();
    fire("pointerdown", 50, 150);
    fire("pointerup", 500, 150);
    expect(group()).toMatchObject({ x: 350 - MIN_NODE_WIDTH, width: MIN_NODE_WIDTH, y: 50, height: 200 });
    expect(submitted).toHaveLength(1);
    controller.dispose();
  });

  it("keeps read-only frames selectable without starting resize or move previews", () => {
    const { fire, controller, style, group } = setup(false);
    for (const [x, y] of [[50, 150], [150, 54]]) {
      fire("pointermove", x, y);
      expect(style.cursor).toBe("");
      fire("pointerdown", x, y);
      fire("pointermove", x + 30, y + 30);
      fire("pointerup", x + 30, y + 30);
    }
    expect(submitted).toHaveLength(0);
    expect(group()).toMatchObject({ x: 50, y: 50, width: 300, height: 200 });
    controller.dispose();
  });

  it("cancels position and size together and does not move from interior space", () => {
    const { fire, controller, group } = setup();
    fire("pointerdown", 50, 150);
    fire("pointermove", 30, 150);
    fire("pointercancel", 30, 150);
    controller.flush();
    expect(group()).toMatchObject({ x: 50, y: 50, width: 300, height: 200 });
    expect(submitted).toHaveLength(0);
    fire("pointerdown", 300, 150);
    fire("pointermove", 320, 170);
    fire("pointerup", 320, 170);
    expect(submitted).toHaveLength(0);
    controller.dispose();
  });
});
