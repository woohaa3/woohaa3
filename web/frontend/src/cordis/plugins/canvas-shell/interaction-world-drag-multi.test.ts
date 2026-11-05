/**
 * 交互控制器测试：多选世界模型一起地面拖动。
 *
 * 框选/Shift 选中多个世界实例后，拖动其中一个应把同一地面增量写入全部实例，
 * 且只提交一个包含多条 nodeData.patch 的批次。
 */
import { afterEach, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { installInteractionController } from "./interaction-controller.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { getSession, harness, installSharedSession, runtimeCapturing, submitted } from "./test-support/controller-harness.js";

installSharedSession();
afterEach(() => nodeSelectionStore.reset());

const instance = (instanceId: string, u: number, v: number, h: number) => ({
  kind: "world-instance" as const,
  version: "shared-world-v1" as const,
  instanceId,
  transform: {
    version: "shared-world-v1" as const,
    position: { u, v, h },
    rotation: [0, 0, 0, 1] as const,
    scale: 1
  }
});

function worldCanvas(): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  return {
    ...base,
    revision: 1,
    document: { ...base.document, nodes: [
      { id: "m1", type: "model3d", position: { x: 100, y: 100 }, width: 200, height: 160 },
      { id: "m2", type: "model3d", position: { x: 300, y: 100 }, width: 200, height: 160 }
    ] },
    nodeData: {
      m1: { sharedWorldInstance: instance("i1", 2, 3, 4) },
      m2: { sharedWorldInstance: instance("i2", -1, 2, 0.5) }
    }
  } as unknown as ServerCanvas;
}

function setup() {
  woohaa3CanvasStore.getState().applyRemoteCanvas(worldCanvas());
  const dom = harness();
  const { runtime } = runtimeCapturing();
  let ground = { u: 0, v: 0 };
  runtime.queryWorldGround = () => ({
    ok: true, generation: runtime.interactionGeneration?.() ?? 0, value: { ...ground }
  });
  const controller = installInteractionController({
    canvas: dom.canvas, getRuntime: () => runtime, getSession: () => getSession() as never,
    target: dom.target as never
  });
  controller.flush();
  submitted.length = 0;
  return { dom, controller, setGround: (next: { u: number; v: number }) => { ground = next; } };
}

it("多选世界模型时同一地面增量应用到全部实例并一次提交", () => {
  const { dom, controller, setGround } = setup();
  // 选中 m1。
  dom.fire("pointerdown", { clientX: 150, clientY: 140 });
  dom.fire("pointerup", { clientX: 150, clientY: 140 });
  expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual(["m1"]);
  // Shift 加选 m2。
  dom.fire("pointerdown", { clientX: 350, clientY: 140, shiftKey: true });
  dom.fire("pointerup", { clientX: 350, clientY: 140, shiftKey: true });
  expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual(["m1", "m2"]);

  // 拖动已选中的 m1：整批移动。
  dom.fire("pointerdown", { clientX: 150, clientY: 140 });
  setGround({ u: 1, v: 2 });
  dom.fire("pointermove", { clientX: 170, clientY: 130 });
  dom.fire("pointerup", { clientX: 170, clientY: 130 });
  controller.flush();

  const patches = submitted.filter(command => command.type === "nodeData.patch") as unknown as Array<{
    nodeId: string;
    value: { sharedWorldInstance: { instanceId: string; transform: { position: { u: number; v: number; h: number } } } };
  }>;
  expect(patches).toHaveLength(2);
  const byId = new Map(patches.map(patch => [patch.nodeId, patch.value.sharedWorldInstance]));
  expect(byId.get("m1")?.transform.position).toEqual({ u: 3, v: 5, h: 4 });
  expect(byId.get("m2")?.transform.position).toEqual({ u: 0, v: 4, h: 0.5 });
  expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual(["m1", "m2"]);
  controller.dispose();
});
