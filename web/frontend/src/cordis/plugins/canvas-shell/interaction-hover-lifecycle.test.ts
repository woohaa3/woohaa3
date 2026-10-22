/**
 * 模型动画 hover 生命周期测试
 * （change: play-model-animations-on-hover，任务 3.2 / 3.3）。
 *
 * 模型动画以 `CanvasRenderScene.hover.nodeId` 为唯一播放触发。这里断言 Canvas Shell 在
 * pointer leave、不兼容画布手势、modal 激活、页面隐藏与 runtime detach 时都清除有效 hover
 * 投影（即提交无 hover scene），且不需要任何新 schema 字段。
 *
 * 沿用 `interaction-pointer` 的既有 hover 投影断言（`hover.nodeId` / `hover.edgeId`），
 * 不修改 canvas 命令、Y.Doc 或视频 hover session。
 */
import { describe, expect, it, afterEach } from "vitest";
import type { ServerCanvas } from "@woohaa3/contracts";
import { installInteractionController } from "./interaction-controller.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { hoverNodeStore } from "../../services/hover-store.js";
import {
  canvasWith, getSession, harness, installSharedSession, runtimeCapturing, setSession, submitted
} from "./test-support/controller-harness.js";

installSharedSession();
afterEach(() => {
  nodeSelectionStore.reset();
  hoverNodeStore.reset();
});

/** 一个 image 节点（248x232），指针在卡片中心即命中。 */
function singleNodeCanvas(): ServerCanvas {
  return canvasWith([{ id: "n1", x: 0, y: 0 }]);
}

/** 一个 3D 模型节点（generate 渲染为模型卡），用于模型网格 hover。 */
function modelNodeCanvas(): ServerCanvas {
  const base = canvasWith([{ id: "m1", x: 0, y: 0 }]);
  return {
    ...base,
    document: {
      ...base.document,
      nodes: [{ id: "m1", type: "model3d", position: { x: 0, y: 0 } } as never]
    }
  };
}

function setup(options: { isModalActive?: () => boolean } = {}) {
  const dom = harness();
  const { runtime, scenes } = runtimeCapturing();
  const controller = installInteractionController({
    canvas: dom.canvas,
    getRuntime: () => runtime,
    getSession: () => getSession() as never,
    target: dom.target as never,
    ...(options.isModalActive ? { isModalActive: options.isModalActive } : {})
  });
  const lastHover = () =>
    (scenes.at(-1) as { hover?: unknown } | undefined)?.hover;
  return { dom, controller, lastHover };
}

describe("模型动画 hover 生命周期（change: play-model-animations-on-hover）", () => {
  it("静止 / 空白不携带 hover，悬停节点后携带，离开后清除", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(singleNodeCanvas());
    const { dom, controller, lastHover } = setup();

    // 静止：未移动指针，不携带 hover（模型保持初始姿态）。
    controller.flush();
    expect(lastHover()).toBeUndefined();

    // 指针进入节点：投影 hover.nodeId（运行时据此从零播放）。
    dom.fire("pointermove", { clientX: 100, clientY: 100 });
    controller.flush();
    expect(lastHover()).toEqual({ nodeId: "n1", port: null });

    // 离开画布：清除 hover 投影（运行时停止并恢复初始姿态）。
    dom.fire("pointerleave", {});
    controller.flush();
    expect(lastHover()).toBeUndefined();
    // hover 全程不产生规范命令。
    expect(submitted).toHaveLength(0);
    controller.dispose();
  });

  it("开始画布手势即清除 hover 投影（避免手势期间继续播放）", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(singleNodeCanvas());
    const { dom, controller, lastHover } = setup();
    dom.fire("pointermove", { clientX: 100, clientY: 100 });
    controller.flush();
    expect(lastHover()).toEqual({ nodeId: "n1", port: null });

    // 在节点上按下开始拖动：hover 被清除，拖动中移动指针也不再建立 hover。
    dom.fire("pointerdown", { clientX: 100, clientY: 100, button: 0 });
    controller.flush();
    expect(lastHover()).toBeUndefined();
    dom.fire("pointermove", { clientX: 140, clientY: 130 });
    controller.flush();
    expect(lastHover()).toBeUndefined();
    controller.dispose();
  });

  it("modal 激活时清除 hover，且后续 pointermove 不再建立 hover", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(singleNodeCanvas());
    let modal = false;
    const { dom, controller, lastHover } = setup({ isModalActive: () => modal });
    dom.fire("pointermove", { clientX: 100, clientY: 100 });
    controller.flush();
    expect(lastHover()).toEqual({ nodeId: "n1", port: null });

    modal = true;
    dom.fire("pointermove", { clientX: 101, clientY: 101 });
    controller.flush();
    expect(lastHover()).toBeUndefined();
    controller.dispose();
  });

  it("页面隐藏 / 窗口失焦清除 hover", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(singleNodeCanvas());
    const { dom, controller, lastHover } = setup();
    dom.fire("pointermove", { clientX: 100, clientY: 100 });
    controller.flush();
    expect(lastHover()).toEqual({ nodeId: "n1", port: null });

    dom.fire("visibilitychange", {});
    controller.flush();
    expect(lastHover()).toBeUndefined();

    dom.fire("pointermove", { clientX: 100, clientY: 100 });
    controller.flush();
    expect(lastHover()).toEqual({ nodeId: "n1", port: null });
    dom.fire("blur", {});
    controller.flush();
    expect(lastHover()).toBeUndefined();
    controller.dispose();
  });

  it("runtime detach（dispose）提交无 hover 状态且不产生规范命令", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(singleNodeCanvas());
    const { dom, controller, lastHover } = setup();
    dom.fire("pointermove", { clientX: 100, clientY: 100 });
    controller.flush();
    expect(lastHover()).toEqual({ nodeId: "n1", port: null });

    controller.dispose();
    expect(submitted).toHaveLength(0);
  });

  it("连线 hover 与节点 hover 互斥（模型动画只在 node hover 触发）", () => {
    const base = canvasWith([
      { id: "n1", x: 0, y: 0 },
      { id: "n2", x: 600, y: 0 }
    ]);
    base.document.edges = [{ id: "e1", source: "n1", target: "n2", data: {}, sourceHandle: null, targetHandle: null }];
    woohaa3CanvasStore.getState().applyRemoteCanvas(base);
    setSession({
      isWritable: () => true,
      submitCommands: () => ({ ok: true as const })
    } as never);
    const { dom, controller, lastHover } = setup();

    // 连线中点：hover 投影为 edgeId，不含 nodeId（无模型播放）。
    dom.fire("pointermove", { clientX: 424, clientY: 116 });
    controller.flush();
    expect(lastHover()).toEqual({ edgeId: "e1" });

    // 指针移到节点：切换为 nodeId hover。
    dom.fire("pointermove", { clientX: 100, clientY: 100 });
    controller.flush();
    expect(lastHover()).toEqual({ nodeId: "n1", port: null });
    controller.dispose();
  });

  it("悬停模型本体（卡片下方的模型网格）也建立 node hover 以驱动播放", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(modelNodeCanvas());
    const dom = harness();
    const { runtime, scenes } = runtimeCapturing({
      // 模型 AABB picking：只在卡片底部下方一段的“模型区”命中 m1。
      modelPick: ({ y }) => (y >= 250 && y <= 400 ? { nodeId: "m1", target: [0, 0, 0], radius: 2 } : null)
    });
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });
    const lastHover = () => (scenes.at(-1) as { hover?: unknown } | undefined)?.hover;

    // 卡片外、模型区内的点：queryPoint 视为空白，但模型 picking 命中 → 应投影 hover.nodeId。
    dom.fire("pointermove", { clientX: 120, clientY: 300 });
    controller.flush();
    expect(lastHover()).toEqual({ nodeId: "m1", port: null });

    // 模型区外：清除 hover（模型恢复初始姿态）。
    dom.fire("pointermove", { clientX: 120, clientY: 700 });
    controller.flush();
    expect(lastHover()).toBeUndefined();
    controller.dispose();
  });

  it("悬停模型本体在 modal 激活或手势期间不建立 hover", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(modelNodeCanvas());
    let modal = false;
    const dom = harness();
    const { runtime, scenes } = runtimeCapturing({
      modelPick: ({ y }) => (y >= 250 && y <= 400 ? { nodeId: "m1", target: [0, 0, 0], radius: 2 } : null)
    });
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never,
      isModalActive: () => modal
    });
    const lastHover = () => (scenes.at(-1) as { hover?: unknown } | undefined)?.hover;

    dom.fire("pointermove", { clientX: 120, clientY: 300 });
    controller.flush();
    expect(lastHover()).toEqual({ nodeId: "m1", port: null });

    // modal 激活后模型区上方移动：清除 hover 且不重建。
    modal = true;
    dom.fire("pointermove", { clientX: 121, clientY: 301 });
    controller.flush();
    expect(lastHover()).toBeUndefined();
    controller.dispose();
  });
});

/**
 * 地面范围 hover 资格
 * （change: 2026-10-13-add-film-set-hover-camera-entity，design D4；
 *  change: 2026-10-15-add-film-set-shooting-shot-previews，design D6）。
 *
 * 覆盖 queryPoint → modelPick → hover store 全链路的越界原因与控件资格：片场地面范围命中
 * 保留 2D hover 高亮，但**不再**建立普通播放 hover（D6 移除地面/default 开播路径，改由动态
 * 拍摄镜头预览内容区建立）；三 AABB 空白角不建立；选中抓手保留 2D 高亮但不作为播放入口；
 * 普通模型本体回退保留。Rust 侧候选排除由 `canvas_query` / `model3d::pick` 单测覆盖。
 */
describe("片场地面 hover 资格（change: 2026-10-13-add-film-set-hover-camera-entity）", () => {
  /** 片场（composite-asset）节点 + 选中态，用于地面范围命中与选中抓手。 */
  function filmSetCanvas(): ServerCanvas {
    const base = canvasWith([{ id: "film", x: 0, y: 0 }]);
    return {
      ...base,
      document: {
        ...base.document,
        nodes: [{ id: "film", type: "composite-asset", position: { x: 0, y: 0 }, width: 260, height: 195 } as never]
      }
    };
  }

  /** 指针世界坐标 → 是否落在片场地面范围（测试基线简化菱形）。 */
  function insideScope(x: number, y: number): boolean {
    // 中心 (130, 97.5)，等价地面半径 rx=113.1, ry=56.6（AXIS 0.7071/0.3536，hx=hz=80）。
    const dx = Math.abs((x - 130) / 113.137);
    const dy = Math.abs((y - 97.5) / 56.569);
    return dx + dy <= 1.0001;
  }

  it("地面范围内只保留 2D 高亮、不再建立播放 hover；范围外 AABB 空白角（模型 AABB 内）两者都清空", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(filmSetCanvas());
    const dom = harness();
    // 模拟生产：复合资产不进入模型候选（Rust 排除），因此模型回退返回 null。
    const { runtime, scenes } = runtimeCapturing({
      modelPick: () => null,
      pointHit: ({ x, y }) => (insideScope(x, y) ? { kind: "film-scope", nodeId: "film" } : null)
    });
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });
    const lastHover = () => (scenes.at(-1) as { hover?: unknown } | undefined)?.hover;
    const hoverPublished = () => hoverNodeStore.getNodeId();

    // 范围内部：保留卡片 2D 高亮，但地面不再是播放入口（D6 移除地面开播路径）。
    dom.fire("pointermove", { clientX: 130, clientY: 98 });
    controller.flush();
    expect(lastHover()).toEqual({ nodeId: "film", port: null });
    expect(hoverPublished()).toBeNull();

    // 同一卡片 AABB 空白角、地面范围外：hover 清空，且不得由模型 AABB 回退重建。
    dom.fire("pointermove", { clientX: 8, clientY: 12 });
    controller.flush();
    expect(lastHover()).toBeUndefined();
    expect(hoverPublished()).toBeNull();
    expect(submitted).toHaveLength(0);
    controller.dispose();
  });

  it("范围外选中抓手保留 2D 高亮但不作为播放入口", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(filmSetCanvas());
    const dom = harness();
    const { runtime, scenes } = runtimeCapturing({
      modelPick: () => null,
      pointHit: () => ({ kind: "resize", nodeId: "film", handle: "e" })
    });
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });
    const lastHover = () => (scenes.at(-1) as { hover?: unknown } | undefined)?.hover;

    dom.fire("pointermove", { clientX: 243, clientY: 98 });
    controller.flush();
    // 控件命中仍保留 2D hover 高亮（抓手/卡片呈现），但播放入口不建立。
    expect(lastHover()).toEqual({ nodeId: "film", port: null });
    expect(hoverNodeStore.getNodeId()).toBeNull();
    controller.dispose();
  });

  it("普通模型本体回退仍建立播放 hover；过期查询清空", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(modelNodeCanvas());
    const dom = harness();
    const { runtime, scenes } = runtimeCapturing({
      // 卡片空白、模型网格命中 m1（普通 model3d 回退保留）。
      modelPick: ({ y }) => (y >= 250 ? { nodeId: "m1", target: [0, 0, 0], radius: 2 } : null)
    });
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });
    const lastHover = () => (scenes.at(-1) as { hover?: unknown } | undefined)?.hover;

    dom.fire("pointermove", { clientX: 120, clientY: 300 });
    controller.flush();
    expect(lastHover()).toEqual({ nodeId: "m1", port: null });
    expect(hoverNodeStore.getNodeId()).toBe("m1");

    // 离开画布清空 hover（含发布入口）。
    dom.fire("pointerleave", {});
    controller.flush();
    expect(lastHover()).toBeUndefined();
    expect(hoverNodeStore.getNodeId()).toBeNull();
    controller.dispose();
  });

  it("片场卡片 hover 在 modal 激活或画布手势期间被清除且不重建", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(filmSetCanvas());
    let modal = false;
    const dom = harness();
    const { runtime, scenes } = runtimeCapturing({
      modelPick: () => null,
      pointHit: ({ x, y }) => (insideScope(x, y) ? { kind: "film-scope", nodeId: "film" } : null)
    });
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never,
      isModalActive: () => modal
    });
    const lastHover = () => (scenes.at(-1) as { hover?: unknown } | undefined)?.hover;

    // 地面范围内建立卡片 2D 高亮（不建立播放入口）。
    dom.fire("pointermove", { clientX: 130, clientY: 98 });
    controller.flush();
    expect(lastHover()).toEqual({ nodeId: "film", port: null });
    expect(hoverNodeStore.getNodeId()).toBeNull();

    // modal 激活：清除并阻止后续 pointermove 重建地面 hover。
    modal = true;
    dom.fire("pointermove", { clientX: 131, clientY: 99 });
    controller.flush();
    expect(lastHover()).toBeUndefined();
    expect(hoverNodeStore.getNodeId()).toBeNull();
    controller.dispose();
  });

  it("片场地面 hover 在开始画布手势时清除", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(filmSetCanvas());
    const dom = harness();
    const { runtime, scenes } = runtimeCapturing({
      modelPick: () => null,
      pointHit: ({ x, y }) => (insideScope(x, y) ? { kind: "film-scope", nodeId: "film" } : null)
    });
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });
    const lastHover = () => (scenes.at(-1) as { hover?: unknown } | undefined)?.hover;

    dom.fire("pointermove", { clientX: 130, clientY: 98 });
    controller.flush();
    expect(lastHover()).toEqual({ nodeId: "film", port: null });

    // 在地面范围内按下开始拖动：清除 hover，拖动中移动指针不再建立。
    dom.fire("pointerdown", { clientX: 130, clientY: 98, button: 0 });
    controller.flush();
    expect(lastHover()).toBeUndefined();
    expect(hoverNodeStore.getNodeId()).toBeNull();
    dom.fire("pointermove", { clientX: 135, clientY: 100 });
    controller.flush();
    expect(lastHover()).toBeUndefined();
    expect(hoverNodeStore.getNodeId()).toBeNull();
    controller.dispose();
  });
});
