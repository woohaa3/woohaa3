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

  it("组可反复拉大缩小，最小尺寸贴住成员（不再预留包围盒留白）", () => {
    const member = { id: "m", type: "image", parentId: "n1", position: { x: 40, y: 40 }, width: 200, height: 100 };
    const { dom, controller, scenes, handle } = setupResizable("group", 500, 400, [member]);
    dom.fire("pointerdown", { clientX: 20, clientY: 20 });
    dom.fire("pointerup", { clientX: 20, clientY: 20 });
    controller.flush();
    submitted.length = 0;
    dom.fire("pointerdown", { clientX: handle.x, clientY: handle.y });
    dom.fire("pointermove", { clientX: handle.x + 100, clientY: handle.y + 80 });
    dom.fire("pointerup", { clientX: handle.x + 100, clientY: handle.y + 80 });
    controller.flush();
    const grow = submitted.filter(entry => entry.type === "node.update");
    expect(grow).toHaveLength(1);
    expect(grow[0]).toMatchObject({nodeId: "n1", width: 600, height: 480});
    expect((scenes.at(-1) as {nodes: Array<{id: string; width: number; height: number}>}).nodes.find(n => n.id === "n1"))
      .toMatchObject({width: 600, height: 480});
    submitted.length = 0;
    dom.fire("pointerdown", { clientX: 590, clientY: 470 });
    dom.fire("pointermove", { clientX: -1000, clientY: -1000 });
    dom.fire("pointerup", { clientX: -1000, clientY: -1000 });
    controller.flush();
    const shrink = submitted.filter(entry => entry.type === "node.update");
    expect(shrink).toHaveLength(1);
    // 右下角固定左上角；宽度收到成员右边 240，高度保留底部页脚 80（140 + 80）。
    expect(shrink[0]).toMatchObject({nodeId: "n1", width: 240, height: 220});
    expect(submitted.some(entry => "nodeId" in entry && entry.nodeId === "m")).toBe(false);
    expect(woohaa3CanvasStore.getState().canvas?.document.nodes.find(n => n.id === "m")?.position)
      .toEqual({x: 40, y: 40});
    controller.dispose();
  });

  it("组四角都能拖拽缩放：左上角固定右下角，并同时提交 position", () => {
    const member = { id: "m", type: "image", parentId: "n1", position: { x: 40, y: 40 }, width: 200, height: 100 };
    const { dom, controller } = setupResizable("group", 500, 400, [member]);
    dom.fire("pointerdown", { clientX: 20, clientY: 20 });
    dom.fire("pointerup", { clientX: 20, clientY: 20 });
    controller.flush();
    submitted.length = 0;

    // 左上角抓手命中框贴住内缘 20×20；向内拖 40/20 后右/下边保持不动。
    dom.fire("pointerdown", { clientX: 5, clientY: 5 });
    dom.fire("pointermove", { clientX: 45, clientY: 25 });
    dom.fire("pointerup", { clientX: 45, clientY: 25 });
    controller.flush();

    const update = submitted.filter((entry) => entry.type === "node.update");
    expect(update).toHaveLength(2);
    expect(update[0]).toMatchObject({ nodeId: "n1", width: 460, height: 380, position: { x: 40, y: 20 } });
    // 成员保持画布绝对位置：组原点右移 40、下移 20，成员局部坐标反向补偿。
    expect(update[1]).toMatchObject({ nodeId: "m", position: { x: 0, y: 20 } });
    controller.dispose();
  });

  it("成员挡住右下角时左侧仍能缩到成员边界，且成员不动", () => {
    // 组 800×700 @ (300,200)，唯一成员贴在右下：绝对 (900,600) 150×150。
    // 旧规则按「成员包围盒 + 留白」把宽度卡在 790，左侧几乎缩不动。
    const member = { id: "m", type: "image", parentId: "n1", position: { x: 600, y: 400 }, width: 150, height: 150 };
    const { dom, controller, scenes } = setupResizable("group", 800, 700, [member], { x: 300, y: 200 });
    dom.fire("pointerdown", { clientX: 320, clientY: 220 });
    dom.fire("pointerup", { clientX: 320, clientY: 220 });
    controller.flush();
    submitted.length = 0;

    dom.fire("pointerdown", { clientX: 300, clientY: 200 });
    dom.fire("pointermove", { clientX: 600, clientY: 400 });
    controller.flush();
    const preview = scenes.at(-1) as { nodes: Array<{ id: string; x: number; y: number }> };
    expect(preview.nodes.find(node => node.id === "m")).toMatchObject({ x: 900, y: 600 });
    dom.fire("pointerup", { clientX: 600, clientY: 400 });
    controller.flush();

    const update = submitted.filter(entry => entry.type === "node.update");
    expect(update[0]).toMatchObject({ nodeId: "n1", width: 500, height: 500, position: { x: 600, y: 400 } });
    expect(update[1]).toMatchObject({ nodeId: "m", position: { x: 300, y: 200 } });
    controller.dispose();
  });

  it("组左侧缩到底停在成员边界，不会把成员挤出框", () => {
    const member = { id: "m", type: "image", parentId: "n1", position: { x: 600, y: 400 }, width: 150, height: 150 };
    const { dom, controller } = setupResizable("group", 800, 700, [member]);
    dom.fire("pointerdown", { clientX: 20, clientY: 20 });
    dom.fire("pointerup", { clientX: 20, clientY: 20 });
    controller.flush();
    submitted.length = 0;

    dom.fire("pointerdown", { clientX: 0, clientY: 0 });
    dom.fire("pointermove", { clientX: 5000, clientY: 5000 });
    dom.fire("pointerup", { clientX: 5000, clientY: 5000 });
    controller.flush();

    const update = submitted.filter(entry => entry.type === "node.update");
    // 右/下边固定在 800/700，左边缘停在成员左边界 600、上边缘停在成员上边界 400。
    expect(update[0]).toMatchObject({ nodeId: "n1", width: 200, height: 300, position: { x: 600, y: 400 } });
    expect(update[1]).toMatchObject({ nodeId: "m", position: { x: 0, y: 0 } });
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

