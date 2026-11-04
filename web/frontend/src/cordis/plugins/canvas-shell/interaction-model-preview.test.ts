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

describe("卡片内模型交互已关闭（CARD_MODEL_INTERACTION = false）", () => {
  /**
   * 卡片里的模型只是缩略图：拖转、滚轮缩放都交回画布（移动/缩放卡片与视口）。
   * 要看模型请走横条「查看 3D」进聚焦工作区 —— 那里的旋转/缩放/平移不受这里影响。
   */
  it("已选中模型拖动移动卡片本身，不旋转模型", () => {
    const { active, fire, point } = setup();
    active.selectNode("model");
    const start = point();
    const view = { ...modelPreviewStore.get("model") };
    fire("pointerdown", { clientX: start.x, clientY: start.y });
    fire("pointermove", { clientX: start.x + 60, clientY: start.y + 15 });
    fire("pointerup", { clientX: start.x + 60, clientY: start.y + 15 });
    active.flush();
    expect(submitted.some((command) => command.type === "node.update")).toBe(true);
    expect(modelPreviewStore.get("model")).toEqual(view);
  });

  it.each([false, true])("滚轮在卡片上缩放视口，不改模型机位（捏合=%s）", (ctrlKey) => {
    const { active, fire, point, stopPropagation } = setup();
    active.selectNode("model");
    const initial = { ...modelPreviewStore.get("model") };
    const before = active.viewport();
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
    expect(active.viewport()).not.toEqual(before);
    expect(modelPreviewStore.get("model")).toEqual(initial);
    expect(stopPropagation).not.toHaveBeenCalled();
  });

  it("Shift 点击取消选择，卡片机位不变", () => {
    const { active, fire, point } = setup();
    active.selectNode("model");
    const at = point(),
      view = { ...modelPreviewStore.get("model") };
    fire("pointerdown", { clientX: at.x, clientY: at.y, shiftKey: true });
    fire("pointerup", { clientX: at.x, clientY: at.y, shiftKey: true });
    expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual([]);
    expect(modelPreviewStore.get("model")).toEqual(view);
  });

  it("未选中时拖动选择并移动节点，不旋转模型", () => {
    const { active, fire, point } = setup();
    const start = point();
    const view = { ...modelPreviewStore.get("model") };
    fire("pointerdown", { clientX: start.x, clientY: start.y });
    fire("pointermove", { clientX: start.x + 60, clientY: start.y + 15 });
    fire("pointerup", { clientX: start.x + 60, clientY: start.y + 15 });
    active.flush();
    expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual(["model"]);
    expect(submitted.some((command) => command.type === "node.update")).toBe(true);
    expect(modelPreviewStore.get("model")).toEqual(view);
  });
});
