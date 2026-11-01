/**
 * 交互控制器测试：resize 手势与 modal 输入门禁
 * （由 interaction-controller.test.ts 机械拆分，断言不变）。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { installInteractionController } from "./interaction-controller.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import {
  canvasWith, getSession, harness, installSharedSession, runtimeCapturing, submitted
} from "./test-support/controller-harness.js";

installSharedSession();

function setupResizable(
  type = "image",
  width = 300,
  height = 200,
  members: ServerCanvas["document"]["nodes"] = [],
  position = { x: 0, y: 0 }
) {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  const canvasState: ServerCanvas = {
    ...base,
    revision: 1,
    document: {
      ...base.document,
      nodes: [{ id: "n1", type, position, width, height }, ...members]
    }
  };
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvasState);
  const dom = harness();
  const { runtime, scenes } = runtimeCapturing();
  const controller = installInteractionController({
    canvas: dom.canvas,
    getRuntime: () => runtime,
    getSession: () => getSession() as never,
    target: dom.target as never
  });
  // 抓手中心（世界坐标=CSS 坐标，zoom=1）。
  const handle = { x: position.x + width - 10, y: position.y + height - 10 };
  return { dom, controller, scenes, handle, width, height };
}

describe("resize 手势（change: add-node-resize）", () => {
  it("拖拽抓手提交一次 node.update{width,height}，并保留预览防闪回", () => {
    const { dom, controller, scenes, handle } = setupResizable("image", 300, 200);
    // 先选中（命中 node 后 setSelection）。
    dom.fire("pointerdown", { clientX: 150, clientY: 100 });
    dom.fire("pointerup", { clientX: 150, clientY: 100 });
    controller.flush();
    submitted.length = 0;

    dom.fire("pointerdown", { clientX: handle.x, clientY: handle.y });
    dom.fire("pointermove", { clientX: handle.x + 100, clientY: handle.y + 50 });
    dom.fire("pointerup", { clientX: handle.x + 100, clientY: handle.y + 50 });

    const resize = submitted.filter((command) => command.type === "node.update" && (command as { width?: number }).width !== undefined);
    expect(resize).toHaveLength(1);
    // 自由缩放：宽 +100、高 +50（两个轴独立变化，不锁比例）。
    const command = resize[0] as { width: number; height: number };
    expect(command.width).toBe(400);
    expect(command.height).toBe(250);

    // 权威尺寸尚未回流，快照仍是拖后的尺寸（不闪回）。
    controller.flush();
    const last = scenes.at(-1) as { nodes: Array<{ id: string; width: number; height: number }> };
    const rendered = last.nodes.find((node) => node.id === "n1")!;
    expect(rendered.width).toBeCloseTo(command.width, 0);
    controller.dispose();
  });





  it("图片节点宽高也可独立变化（节点不受宽高比锁定）", () => {
    const { dom, controller, handle, width } = setupResizable("image", 300, 200);
    dom.fire("pointerdown", { clientX: 150, clientY: 100 });
    dom.fire("pointerup", { clientX: 150, clientY: 100 });
    controller.flush();
    submitted.length = 0;

    // 只横向拉大：高度保持不变（自由缩放）。
    dom.fire("pointerdown", { clientX: handle.x, clientY: handle.y });
    dom.fire("pointermove", { clientX: handle.x + 200, clientY: handle.y });
    dom.fire("pointerup", { clientX: handle.x + 200, clientY: handle.y });

    const command = submitted.find((entry) => entry.type === "node.update" && (entry as { width?: number }).width !== undefined) as { width: number; height: number };
    expect(command.width).toBe(width + 200);
    expect(command.height).toBe(200);
    controller.dispose();
  });

  it("非图片节点宽高可独立变化", () => {
    const { dom, controller, handle } = setupResizable("text", 300, 200);
    dom.fire("pointerdown", { clientX: 150, clientY: 100 });
    dom.fire("pointerup", { clientX: 150, clientY: 100 });
    controller.flush();
    submitted.length = 0;

    dom.fire("pointerdown", { clientX: handle.x, clientY: handle.y });
    dom.fire("pointermove", { clientX: handle.x + 100, clientY: handle.y });
    dom.fire("pointerup", { clientX: handle.x + 100, clientY: handle.y });

    const command = submitted.find((entry) => entry.type === "node.update" && (entry as { width?: number }).width !== undefined) as { width: number; height: number };
    expect(command.width).toBeGreaterThan(380);
    expect(command.height).toBe(200);
    controller.dispose();
  });

  it("拖到小于下限被 clamp 到最小值", () => {
    const { dom, controller, handle } = setupResizable("text", 300, 200);
    dom.fire("pointerdown", { clientX: 150, clientY: 100 });
    dom.fire("pointerup", { clientX: 150, clientY: 100 });
    controller.flush();
    submitted.length = 0;

    dom.fire("pointerdown", { clientX: handle.x, clientY: handle.y });
    dom.fire("pointermove", { clientX: -1000, clientY: -1000 });
    dom.fire("pointerup", { clientX: -1000, clientY: -1000 });

    const command = submitted.find((entry) => entry.type === "node.update" && (entry as { width?: number }).width !== undefined) as { width: number; height: number };
    expect(command.width).toBe(180);
    expect(command.height).toBe(64);
    controller.dispose();
  });

  it("无净变化不提交", () => {
    const { dom, controller, handle } = setupResizable("text", 300, 200);
    dom.fire("pointerdown", { clientX: 150, clientY: 100 });
    dom.fire("pointerup", { clientX: 150, clientY: 100 });
    controller.flush();
    submitted.length = 0;

    dom.fire("pointerdown", { clientX: handle.x, clientY: handle.y });
    dom.fire("pointermove", { clientX: handle.x + 0.2, clientY: handle.y + 0.2 });
    dom.fire("pointerup", { clientX: handle.x + 0.2, clientY: handle.y + 0.2 });

    expect(submitted.filter((entry) => entry.type === "node.update" && (entry as { width?: number }).width !== undefined)).toHaveLength(0);
    controller.dispose();
  });
});

describe("modal 输入门禁（change: add-frontend-dialog-system，任务 3.4 / 3.5）", () => {
  it("modal 打开时不开始拖拽、不提交命令", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const dom = harness();
    const { runtime } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never,
      isModalActive: () => true
    });

    dom.fire("pointerdown", { clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 300, clientY: 100 });
    dom.fire("pointerup", { clientX: 300, clientY: 100 });
    controller.flush();

    expect(submitted).toHaveLength(0);
    controller.dispose();
  });

  it("modal 打开时 wheel 不改变画布视口", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const dom = harness();
    const { runtime } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never,
      isModalActive: () => true
    });
    const before = controller.viewport();
    dom.fire("wheel", { deltaX: 0, deltaY: 120, deltaMode: 0, ctrlKey: false, metaKey: false, clientX: 500, clientY: 300 });
    expect(controller.viewport()).toEqual(before);
    controller.dispose();
  });

  it("cancelTransientGesture 取消未提交草稿且不产生命令", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const dom = harness();
    const { runtime, scenes } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });
    dom.fire("pointerdown", { clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 300, clientY: 100 });
    controller.cancelTransientGesture();
    dom.fire("pointerup", { clientX: 300, clientY: 100 });
    controller.flush();
    expect(submitted).toHaveLength(0);
    // 画布仍渲染权威位置（无残留草稿）。
    const last = scenes.at(-1) as { nodes: Array<{ id: string; x: number }> };
    expect(last.nodes.find((node) => node.id === "n1")?.x).toBe(0);
    controller.dispose();
  });
});

