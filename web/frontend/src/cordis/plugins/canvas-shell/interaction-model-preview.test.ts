import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSelfContained3DNodeData } from "@woohaa3/contracts";
import { installInteractionController } from "./interaction-controller.js";
import type { InteractionController } from "./interaction-types.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { modelPreviewStore } from "../../services/model-preview-store.js";
import {
  canvasWith,
  getSession,
  harness,
  installSharedSession,
  runtimeCapturing,
  submitted,
} from "./test-support/controller-harness.js";

installSharedSession();
let controller: InteractionController | undefined;
afterEach(() => {
  controller?.dispose();
  controller = undefined;
  nodeSelectionStore.reset();
});

function setup() {
  const canvas = canvasWith([
    { id: "model", x: 100, y: 100 },
    { id: "other", x: 600, y: 100 },
  ]);
  canvas.document.nodes[0].type = "model3d";
  canvas.nodeData.model = defaultSelfContained3DNodeData("model3d")!;
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  const dom = harness();
  const { runtime } = runtimeCapturing();
  const queryPoint = runtime.queryPoint!;
  // Simulate the Bevy semantic hit for the preview body, keeping all other queries.
  runtime.queryPoint = (input) => {
    const result = queryPoint(input);
    return result.ok &&
      result.value?.kind === "node" &&
      result.value.nodeId === "model"
      ? { ...result, value: { kind: "model-preview", nodeId: "model" } }
      : result;
  };
  const active = installInteractionController({
    canvas: dom.canvas,
    getRuntime: () => runtime,
    getSession: () => getSession() as never,
    target: dom.target as never,
  });
  controller = active;
  active.flush();
  const stopPropagation = vi.fn();
  const fire = (type: string, event: Record<string, unknown>) =>
    dom.fire(type, { stopPropagation, ...event });
  const point = () => active.worldToClient({ x: 200, y: 200 });
  return { active, fire, point, stopPropagation };
}

describe("模型预览仅在节点已选中时接管手势", () => {
  it("首次拖动未选中预览选择并移动节点，不旋转模型", () => {
    const { active, fire, point } = setup();
    const start = point();
    const view = { ...modelPreviewStore.get("model") };
    fire("pointerdown", { clientX: start.x, clientY: start.y });
    fire("pointermove", { clientX: start.x + 60, clientY: start.y + 15 });
    fire("pointerup", { clientX: start.x + 60, clientY: start.y + 15 });
    active.flush();
    expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual(["model"]);
    expect(submitted.some((command) => command.type === "node.update")).toBe(
      true,
    );
    expect(modelPreviewStore.get("model")).toEqual(view);
  });

  it("已选中模型拖动只旋转，且消费指针事件", () => {
    const { active, fire, point, stopPropagation } = setup();
    active.selectNode("model");
    const start = point(),
      viewport = active.viewport();
    const angle = modelPreviewStore.get("model").azimuth;
    fire("pointerdown", { clientX: start.x, clientY: start.y });
    fire("pointermove", { clientX: start.x + 60, clientY: start.y + 15 });
    fire("pointerup", { clientX: start.x + 60, clientY: start.y + 15 });
    expect(modelPreviewStore.get("model").azimuth).not.toBe(angle);
    expect(active.viewport()).toEqual(viewport);
    expect(submitted).toHaveLength(0);
    expect(stopPropagation).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])("触摸板手势遵循当前选择（捏合=%s）", (ctrlKey) => {
    const { active, fire, point, stopPropagation } = setup();
    const initial = { ...modelPreviewStore.get("model") };
    const wheel = () => {
      const at = point();
      fire("wheel", {
        clientX: at.x,
        clientY: at.y,
        deltaX: 12,
        deltaY: -20,
        deltaMode: 0,
        ctrlKey,
        metaKey: false,
      });
    };
    const before = active.viewport();
    wheel();
    expect(active.viewport()).not.toEqual(before);
    expect(modelPreviewStore.get("model")).toEqual(initial);
    expect(stopPropagation).not.toHaveBeenCalled();

    active.selectNode("model");
    const selectedViewport = active.viewport();
    wheel();
    expect(modelPreviewStore.get("model")).not.toEqual(initial);
    expect(active.viewport()).toEqual(selectedViewport);
    expect(stopPropagation).toHaveBeenCalledTimes(1);

    const selectedView = { ...modelPreviewStore.get("model") };
    active.selectNode("other");
    wheel();
    expect(modelPreviewStore.get("model")).toEqual(selectedView);
    expect(active.viewport()).not.toEqual(selectedViewport);
  });

  it("Shift 点击仍可取消选择，不开启模型旋转", () => {
    const { active, fire, point } = setup();
    active.selectNode("model");
    const at = point(),
      view = { ...modelPreviewStore.get("model") };
    fire("pointerdown", { clientX: at.x, clientY: at.y, shiftKey: true });
    fire("pointerup", { clientX: at.x, clientY: at.y, shiftKey: true });
    expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual([]);
    expect(modelPreviewStore.get("model")).toEqual(view);
    expect(submitted).toHaveLength(0);
  });

  it("手势中取消选择后不继续旋转", () => {
    const { active, fire, point } = setup();
    active.selectNode("model");
    const at = point(),
      view = { ...modelPreviewStore.get("model") };
    fire("pointerdown", { clientX: at.x, clientY: at.y });
    active.selectNode("other");
    fire("pointermove", { clientX: at.x + 50, clientY: at.y });
    fire("pointerup", { clientX: at.x + 50, clientY: at.y });
    expect(modelPreviewStore.get("model")).toEqual(view);
    expect(submitted).toHaveLength(0);
  });
});
