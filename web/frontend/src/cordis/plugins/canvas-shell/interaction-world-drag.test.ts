/**
 * 交互控制器测试：共享世界模型的直接地面拖动。
 *
 * 世界模型没有内容卡片，拖动只能改 `sharedWorldInstance` 的地面位置：
 * - 移动期间只产生瞬时世界位移预览（卡片 position 与规范状态都不变）；
 * - 释放时提交一次 `nodeData.patch`，并清掉预览避免双倍位移；
 * - 取消 / Escape 不提交。
 */
import { expect, it, afterEach } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { installInteractionController } from "./interaction-controller.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { getSession, harness, installSharedSession, runtimeCapturing, submitted } from "./test-support/controller-harness.js";

installSharedSession();
afterEach(() => nodeSelectionStore.reset());

const instance = {
  kind: "world-instance" as const,
  version: "shared-world-v1" as const,
  instanceId: "i1",
  transform: {
    version: "shared-world-v1" as const,
    position: { u: 2, v: 3, h: 4 },
    rotation: [0, 0, 0, 1] as const,
    scale: 1
  }
};

function worldCanvas(): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  return { ...base, revision: 1, document: { ...base.document,
    nodes: [{ id: "m1", type: "model3d", position: { x: 100, y: 100 }, width: 200, height: 160 }] },
    nodeData: { m1: { sharedWorldInstance: instance } } } as unknown as ServerCanvas;
}

function setup() {
  woohaa3CanvasStore.getState().applyRemoteCanvas(worldCanvas());
  const dom = harness();
  const { runtime, scenes } = runtimeCapturing();
  // 测试地面：固定返回 `ground`，由用例直接给出米制坐标。
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
  return { dom, controller, scenes, setGround: (next: { u: number; v: number }) => { ground = next; } };
}

type RenderedNode = { id: string; x: number; sharedWorldInstance?: { transform: { position: { u: number; v: number; h: number } } } };
const renderedPosition = (scenes: Array<Record<string, unknown>>) =>
  (scenes.at(-1) as { nodes: RenderedNode[] }).nodes.find((node) => node.id === "m1")!;

it("世界模型沿地面拖动只预览世界位移，释放提交一次 nodeData.patch 并保留高度", () => {
  const { dom, controller, scenes, setGround } = setup();
  // 点击模型本体（测试命中 oracle 默认按 scene 节点矩形命中）。
  dom.fire("pointerdown", { clientX: 150, clientY: 140 });
  // 首次按下先选中，不提交。
  expect(submitted).toHaveLength(0);
  dom.fire("pointerup", { clientX: 150, clientY: 140 });

  dom.fire("pointerdown", { clientX: 150, clientY: 140 });
  setGround({ u: 1.5, v: -0.5 });
  dom.fire("pointermove", { clientX: 170, clientY: 130 });
  controller.flush();
  // 预览改变了世界位置……
  expect(renderedPosition(scenes).sharedWorldInstance?.transform.position).toEqual({ u: 3.5, v: 2.5, h: 4 });
  // ……但卡片位置与规范数据都没动（模型不随卡片布局移动）。
  expect(renderedPosition(scenes).x).toBe(100);
  expect(woohaa3CanvasStore.getState().working?.nodeData.m1.sharedWorldInstance).toEqual(instance);
  expect(submitted).toHaveLength(0);

  dom.fire("pointerup", { clientX: 170, clientY: 130 });
  controller.flush();
  const patches = submitted.filter((command) => command.type === "nodeData.patch");
  expect(patches).toHaveLength(1);
  const patch = patches[0] as unknown as { nodeId: string; value: { sharedWorldInstance: typeof instance } };
  expect(patch.nodeId).toBe("m1");
  expect(patch.value.sharedWorldInstance.instanceId).toBe("i1");
  expect(patch.value.sharedWorldInstance.transform.position).toEqual({ u: 3.5, v: 2.5, h: 4 });
  expect(patch.value.sharedWorldInstance.transform.rotation).toEqual(instance.transform.rotation);
  // 提交后预览已清除，且不再叠加到已提交的位置之上（否则会变成 5/2 的双倍位移）。
  const settled = renderedPosition(scenes).sharedWorldInstance?.transform.position;
  expect(settled).toEqual({ u: 2, v: 3, h: 4 });
  controller.dispose();
});

it("未越过阈值的点击不提交世界位置", () => {
  const { dom, controller, setGround } = setup();
  dom.fire("pointerdown", { clientX: 150, clientY: 140 });
  setGround({ u: 0.002, v: 0.001 });
  dom.fire("pointermove", { clientX: 150.2, clientY: 140.1 });
  dom.fire("pointerup", { clientX: 150.2, clientY: 140.1 });
  controller.flush();
  expect(submitted.filter((command) => command.type === "nodeData.patch")).toHaveLength(0);
  expect(woohaa3CanvasStore.getState().working?.nodeData.m1.sharedWorldInstance).toEqual(instance);
  controller.dispose();
});

it("拖动中取消（Escape/宿主取消）只清预览，不提交", () => {
  const { dom, controller, scenes, setGround } = setup();
  dom.fire("pointerdown", { clientX: 150, clientY: 140 });
  setGround({ u: 2, v: 2 });
  dom.fire("pointermove", { clientX: 180, clientY: 160 });
  controller.flush();
  controller.cancelTransientGesture();
  controller.flush();
  expect(renderedPosition(scenes).sharedWorldInstance?.transform.position).toEqual({ u: 2, v: 3, h: 4 });
  dom.fire("pointerup", { clientX: 180, clientY: 160 });
  controller.flush();
  expect(submitted).toHaveLength(0);
  expect(woohaa3CanvasStore.getState().working?.nodeData.m1.sharedWorldInstance).toEqual(instance);
  controller.dispose();
});

it("只读会话中世界模型不开始地面拖动", () => {
  const canvas = worldCanvas();
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  const dom = harness();
  const { runtime } = runtimeCapturing();
  const controller = installInteractionController({
    canvas: dom.canvas, getRuntime: () => runtime, getSession: () => getSession() as never,
    target: dom.target as never, isWritable: () => false
  });
  controller.flush();
  submitted.length = 0;
  dom.fire("pointerdown", { clientX: 150, clientY: 140 });
  dom.fire("pointermove", { clientX: 200, clientY: 180 });
  dom.fire("pointerup", { clientX: 200, clientY: 180 });
  controller.flush();
  expect(submitted).toHaveLength(0);
  controller.dispose();
});

it("selects the containing director area before the world model", () => {
  const base = worldCanvas();
  const area = { id: "area", type: "scene-area", position: { x: 0, y: 0 } };
  const canvas = {
    ...base,
    document: { ...base.document, nodes: [...base.document.nodes, area] },
    nodeData: {
      ...base.nodeData,
      area: {
        sceneArea: {
          kind: "scene-area", version: "shared-world-v1", areaId: "a1", scopeVersion: "s1",
          bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } }
        }
      }
    }
  } as unknown as ServerCanvas;
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  const dom = harness();
  const { runtime } = runtimeCapturing();
  const controller = installInteractionController({
    canvas: dom.canvas, getRuntime: () => runtime, getSession: () => getSession() as never,
    target: dom.target as never
  });
  controller.flush();
  submitted.length = 0;
  // 世界模型 `m1` 的地面位置 (2,3) 落在导演区内：第一次点击先选中导演区。
  dom.fire("pointerdown", { clientX: 150, clientY: 140 });
  dom.fire("pointerup", { clientX: 150, clientY: 140 });
  expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual(["area"]);
  // 导演区已选中后，再次点击才落到模型本身。
  dom.fire("pointerdown", { clientX: 150, clientY: 140 });
  dom.fire("pointerup", { clientX: 150, clientY: 140 });
  expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual(["m1"]);
  controller.dispose();
});

it("selects a sibling world model directly once the area is already entered", () => {
  const base = worldCanvas();
  const area = { id: "area", type: "scene-area", position: { x: 0, y: 0 } };
  const model2 = { id: "m2", type: "model3d", position: { x: 400, y: 100 }, width: 200, height: 160 };
  const canvas = {
    ...base,
    document: { ...base.document, nodes: [...base.document.nodes, model2, area] },
    nodeData: {
      ...base.nodeData,
      m2: { sharedWorldInstance: { ...instance, instanceId: "i2", transform: {
        ...instance.transform, position: { u: 6, v: 6, h: 4 }
      } } },
      area: {
        sceneArea: {
          kind: "scene-area", version: "shared-world-v1", areaId: "a1", scopeVersion: "s1",
          bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } }
        }
      }
    }
  } as unknown as ServerCanvas;
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  const dom = harness();
  const { runtime } = runtimeCapturing();
  const controller = installInteractionController({
    canvas: dom.canvas, getRuntime: () => runtime, getSession: () => getSession() as never,
    target: dom.target as never
  });
  controller.flush();
  submitted.length = 0;
  // 第一次进入导演区，第二次才落到 m1。
  dom.fire("pointerdown", { clientX: 150, clientY: 140 });
  dom.fire("pointerup", { clientX: 150, clientY: 140 });
  dom.fire("pointerdown", { clientX: 150, clientY: 140 });
  dom.fire("pointerup", { clientX: 150, clientY: 140 });
  expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual(["m1"]);
  // m1 与 m2 同导演区：点 m2 直接切换，不再先选导演区。
  dom.fire("pointerdown", { clientX: 450, clientY: 140 });
  dom.fire("pointerup", { clientX: 450, clientY: 140 });
  expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual(["m2"]);
  controller.dispose();
});

it("switches sibling world models directly when both are hit only by the renderer pick", () => {
  const base = worldCanvas();
  const area = { id: "area", type: "scene-area", position: { x: 0, y: 0 } };
  const canvas = {
    ...base,
    document: { ...base.document, nodes: [...base.document.nodes, { id: "m2", type: "model3d", position: { x: 400, y: 100 }, width: 200, height: 160 }, area] },
    nodeData: {
      ...base.nodeData,
      m2: { sharedWorldInstance: { ...instance, instanceId: "i2", transform: {
        ...instance.transform, position: { u: 6, v: 6, h: 4 }
      } } },
      area: {
        sceneArea: {
          kind: "scene-area", version: "shared-world-v1", areaId: "a1", scopeVersion: "s1",
          bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } }
        }
      }
    }
  } as unknown as ServerCanvas;
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  const dom = harness();
  const { runtime } = runtimeCapturing({
    pointHit: () => null,
    modelPick: input => ({ nodeId: input.x >= 300 ? "m2" : "m1", target: [0, 0, 0], radius: 1 })
  });
  runtime.queryWorldGround = () => ({ ok: true, generation: runtime.interactionGeneration?.() ?? 0, value: { u: 2, v: 3 } });
  const controller = installInteractionController({
    canvas: dom.canvas, getRuntime: () => runtime, getSession: () => getSession() as never,
    target: dom.target as never
  });
  controller.flush();
  submitted.length = 0;
  dom.fire("pointerdown", { clientX: 150, clientY: 140 });
  dom.fire("pointerup", { clientX: 150, clientY: 140 });
  dom.fire("pointerdown", { clientX: 150, clientY: 140 });
  dom.fire("pointerup", { clientX: 150, clientY: 140 });
  expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual(["m1"]);
  dom.fire("pointerdown", { clientX: 450, clientY: 140 });
  dom.fire("pointerup", { clientX: 450, clientY: 140 });
  expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual(["m2"]);
  controller.dispose();
});

it("does not select a world model when the click misses every exposed surface", () => {
  const base = worldCanvas();
  const area = { id: "area", type: "scene-area", position: { x: 0, y: 0 } };
  const canvas = {
    ...base,
    document: { ...base.document, nodes: [...base.document.nodes, area] },
    nodeData: {
      ...base.nodeData,
      area: {
        sceneArea: {
          kind: "scene-area", version: "shared-world-v1", areaId: "a1", scopeVersion: "s1",
          bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } }
        }
      }
    }
  } as unknown as ServerCanvas;
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  const dom = harness();
  // 指针落在旧实现拿来兜底的 4x4 AABB 内，但没命中任何露出表面；
  // 点击位置在导演区之外（地面 20,20），不能因此选中区内的模型。
  const { runtime } = runtimeCapturing({
    pointHit: () => null,
    modelPick: () => null,
    modelMarquee: () => ["m1"]
  });
  runtime.queryWorldGround = () => ({ ok: true, generation: runtime.interactionGeneration?.() ?? 0, value: { u: 20, v: 20 } });
  // 生产 2D snapshot 不给世界对象保留卡片矩形；测试 oracle 按卡片矩形兜底，这里显式对齐。
  runtime.queryMarquee = () => ({ ok: true, generation: runtime.interactionGeneration?.() ?? 0, value: [] });
  const controller = installInteractionController({
    canvas: dom.canvas, getRuntime: () => runtime, getSession: () => getSession() as never,
    target: dom.target as never
  });
  controller.flush();
  submitted.length = 0;
  dom.fire("pointerdown", { clientX: 150, clientY: 140 });
  // 按下阶段就必须为空：旧实现的 4x4 AABB 兜底会在这里选中 m1。
  expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual([]);
  dom.fire("pointerup", { clientX: 150, clientY: 140 });
  controller.flush();
  expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual([]);
  controller.dispose();
});

it("applies the same area-first rule when the world model is hit only by the renderer pick", () => {
  const base = worldCanvas();
  const area = { id: "area", type: "scene-area", position: { x: 0, y: 0 } };
  const canvas = {
    ...base,
    document: { ...base.document, nodes: [...base.document.nodes, area] },
    nodeData: {
      ...base.nodeData,
      area: {
        sceneArea: {
          kind: "scene-area", version: "shared-world-v1", areaId: "a1", scopeVersion: "s1",
          bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } }
        }
      }
    }
  } as unknown as ServerCanvas;
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  const dom = harness();
  // 真实世界模型没有卡片：点命中为空，只有渲染器拾取返回 nodeId。
  const { runtime } = runtimeCapturing({
    pointHit: () => null,
    modelPick: () => ({ nodeId: "m1", target: [0, 0, 0], radius: 1 })
  });
  runtime.queryWorldGround = () => ({ ok: true, generation: runtime.interactionGeneration?.() ?? 0, value: { u: 2, v: 3 } });
  const controller = installInteractionController({
    canvas: dom.canvas, getRuntime: () => runtime, getSession: () => getSession() as never,
    target: dom.target as never
  });
  controller.flush();
  submitted.length = 0;
  dom.fire("pointerdown", { clientX: 150, clientY: 140 });
  dom.fire("pointerup", { clientX: 150, clientY: 140 });
  expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual(["area"]);
  dom.fire("pointerdown", { clientX: 150, clientY: 140 });
  dom.fire("pointerup", { clientX: 150, clientY: 140 });
  expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual(["m1"]);
  controller.dispose();
});
