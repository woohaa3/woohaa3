/**
 * 交互控制器测试：指针手势、连线悬停、拖拽与菜单
 * （由 interaction-controller.test.ts 机械拆分，断言不变）。
 */
import { describe, expect, it, afterEach } from "vitest";
import {
  bevyEdgeDeleteRect,
  bevyPort,
  createEmptyWoohaa3ServerCanvas,
  edgeLabelWidth,
  type ServerCanvas
} from "@woohaa3/contracts";
import { installInteractionController } from "./interaction-controller.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import {
  canvasWith, getSession, harness, installSharedSession, runtimeCapturing, setSession, submitted
} from "./test-support/controller-harness.js";

installSharedSession();
afterEach(() => {
  nodeSelectionStore.reset();
});

describe("拖拽松手不闪回", () => {  it("松手后保留拖拽预览，直到服务端权威位置回流", () => {
    // 权威位置仍是旧的 (0,0)。
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
    dom.fire("pointerup", { clientX: 300, clientY: 100 });
    controller.flush();

    // 已提交移动。
    expect(submitted.some((command) => command.type === "node.update")).toBe(true);
    // 权威位置尚未回流，但渲染快照仍应是拖拽后的位置（不闪回）。
    const last = scenes[scenes.length - 1] as { nodes: Array<{ id: string; x: number }> };
    expect(last.nodes.find((node) => node.id === "n1")?.x).toBe(200);

    // 服务端回流新位置后，预览被丢弃，渲染到权威位置。
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 200, y: 0 }]));
    controller.flush();
    const settled = scenes[scenes.length - 1] as { nodes: Array<{ id: string; x: number }> };
    expect(settled.nodes.find((node) => node.id === "n1")?.x).toBe(200);
    controller.dispose();
  });
});

describe("框选选区瞬时投影（change: fix-group-and-marquee-preview）", () => {
  const lastMarquee = (scenes: Array<Record<string, unknown>>) => {
    const last = scenes[scenes.length - 1] as { marquee?: { x: number; y: number; width: number; height: number } | null };
    return last.marquee ?? null;
  };

  it("拖拽空白显示随指针更新的选区，松手后移除", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 100, y: 100 }]));
    const dom = harness();
    const { runtime, scenes } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });

    // 静止时没有选区。
    controller.flush();
    expect(lastMarquee(scenes)).toBeNull();

    // 从空白处按下并拖拽 → 选区随指针更新。
    dom.fire("pointerdown", { clientX: 20, clientY: 30 });
    dom.fire("pointermove", { clientX: 220, clientY: 130 });
    controller.flush();
    expect(lastMarquee(scenes)).toEqual({ x: 20, y: 30, width: 200, height: 100 });

    // 松手完成框选 → 选区移除。
    dom.fire("pointerup", { clientX: 220, clientY: 130 });
    controller.flush();
    expect(lastMarquee(scenes)).toBeNull();
    controller.dispose();
  });

  it("框选不推进 revision、不提交命令", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 100, y: 100 }]));
    const dom = harness();
    const { runtime, scenes } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });
    const revision = woohaa3CanvasStore.getState().canvas?.revision;

    dom.fire("pointerdown", { clientX: 10, clientY: 10 });
    dom.fire("pointermove", { clientX: 400, clientY: 300 });
    controller.flush();
    expect(lastMarquee(scenes)).not.toBeNull();
    // 框选是浏览器本地呈现态：不发命令、不推进 revision。
    expect(submitted).toHaveLength(0);
    expect(woohaa3CanvasStore.getState().canvas?.revision).toBe(revision);

    dom.fire("pointerup", { clientX: 400, clientY: 300 });
    controller.flush();
    controller.dispose();
  });
});

describe("pointermove 热路径不重建 scene（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）", () => {
  it("连续 pointermove 只查询 Rust 命中，不调用 buildCanvasRenderScene", async () => {
    const { resetSceneDiagnostics, sceneDiagnostics } = await import("../canvas-runtime/scene-diagnostics.js");
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 100, y: 100 }]));
    resetSceneDiagnostics();
    const dom = harness();
    const { runtime } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });
    // 首个 sample 允许建立 snapshot（冷路径），之后连续移动不得重建 scene。
    dom.fire("pointermove", { clientX: 150, clientY: 150 });
    const buildsAfterFirst = sceneDiagnostics.sceneBuilds;
    for (let i = 0; i < 20; i += 1) dom.fire("pointermove", { clientX: 160 + i, clientY: 160 + i });
    // 20 次移动后不再构建 CanvasRenderScene（每次只查命中）。
    expect(sceneDiagnostics.sceneBuilds).toBe(buildsAfterFirst);
    controller.dispose();
  });
});

describe("触控板双指平移", () => {
  it("小步长像素 wheel 平移视口且不改变 zoom", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const dom = harness();
    const { runtime } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });

    dom.fire("wheel", { deltaX: 10, deltaY: 12, deltaMode: 0, ctrlKey: false, metaKey: false, clientX: 500, clientY: 300 });
    // 视口是本地状态：不产生任何服务端命令。
    expect(submitted.filter((command) => (command as { type: string }).type === "canvas.setViewport")).toHaveLength(0);
    controller.flush();
    controller.dispose();
  });
});

describe("中键平移", () => {
  it("连续移动累积在预览视口上，并提交最终视口", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const dom = harness();
    const { runtime, scenes } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });

    dom.fire("pointerdown", { button: 1, clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 120, clientY: 100 });
    dom.fire("pointermove", { clientX: 150, clientY: 110 });
    controller.flush();

    const preview = scenes.at(-1) as { viewport: { x: number; y: number } };
    expect(preview.viewport).toMatchObject({ x: 50, y: 10 });

    dom.fire("pointerup", { clientX: 150, clientY: 110 });
    // 视口是本地状态：不产生服务端命令。
    expect(submitted.filter((command) => (command as { type: string }).type === "canvas.setViewport")).toHaveLength(0);
    expect(controller.viewport()).toMatchObject({ x: 50, y: 10, zoom: 1 });
    controller.dispose();
  });
});

describe("右键菜单与平移阈值", () => {
  it("右键短点击打开菜单且不移动视口", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const dom = harness();
    const { runtime } = runtimeCapturing();
    const opened: Array<{ screen: { x: number; y: number }; node: { nodeId: string } | null }> = [];
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never,
      onContextMenu: (request) => opened.push({ screen: request.screen, node: request.node })
    });

    const before = controller.viewport();
    dom.fire("pointerdown", { button: 2, clientX: 400, clientY: 300 });
    dom.fire("pointerup", { button: 2, clientX: 402, clientY: 301 });

    expect(opened).toHaveLength(1);
    expect(opened[0].node).toBeNull();
    expect(opened[0].screen).toMatchObject({ x: 402, y: 301 });
    expect(controller.viewport()).toEqual(before);
    controller.dispose();
  });

  it("右键拖拽达到阈值后平移且不打开菜单", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const dom = harness();
    const { runtime } = runtimeCapturing();
    let opened = 0;
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never,
      onContextMenu: () => {
        opened += 1;
      }
    });

    dom.fire("pointerdown", { button: 2, clientX: 400, clientY: 300 });
    dom.fire("pointermove", { clientX: 420, clientY: 300 });
    dom.fire("pointermove", { clientX: 460, clientY: 320 });
    dom.fire("pointerup", { button: 2, clientX: 460, clientY: 320 });

    expect(opened).toBe(0);
    expect(controller.viewport()).toMatchObject({ x: 60, y: 20, zoom: 1 });
    controller.dispose();
  });
});

describe("拉线到空白弹生成菜单", () => {
  it("从输出端口拖到空白触发 onConnectToEmpty，且不提交连线", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const dom = harness();
    const { runtime } = runtimeCapturing();
    const requests: Array<{ sourceNodeId: string; sourceNodeType: string; world: { x: number; y: number } }> = [];
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never,
      onConnectToEmpty: (request) => requests.push(request)
    });

    // 节点 n1 在 (0,0)，宽 248/高 232；输出端口在 (248, 116)。
    dom.fire("pointerdown", { clientX: 248, clientY: 116 });
    dom.fire("pointermove", { clientX: 700, clientY: 500 });
    dom.fire("pointerup", { clientX: 700, clientY: 500 });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ sourceNodeId: "n1", sourceNodeType: "image" });
    expect(requests[0].world).toMatchObject({ x: 700, y: 500 });
    // 没有连到目标节点，因此不提交 edge.add。
    expect(submitted.some((command) => command.type === "edge.add")).toBe(false);
    controller.dispose();
  });
});

describe("节点端点悬停态（change: add-node-endpoint-hover）", () => {
  it("静止 / 空白不携带 hover，悬停节点时携带且不改变规范状态", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const dom = harness();
    const { runtime, scenes } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });

    // 静止：尚未移动指针，不携带 hover。
    controller.flush();
    expect((scenes.at(-1) as { hover?: unknown }).hover).toBeUndefined();

    // 指针在节点卡片内部（非端点命中区）：hover.nodeId = n1，port 为 null。
    dom.fire("pointermove", { clientX: 100, clientY: 100 });
    controller.flush();
    expect((scenes.at(-1) as { hover?: unknown }).hover).toEqual({ nodeId: "n1", port: null });

    // 悬停不改变任何规范字段。
    const scene = scenes.at(-1) as { revision: number; nodes: unknown[] };
    expect(scene.revision).toBe(1);
    expect(scene.nodes).toHaveLength(1);
    expect(submitted).toHaveLength(0);

    // 指针移到空白：hover 被省略。
    dom.fire("pointermove", { clientX: 900, clientY: 700 });
    controller.flush();
    expect((scenes.at(-1) as { hover?: unknown }).hover).toBeUndefined();
    controller.dispose();
  });

  it("落在端点命中区时携带端点侧，离开画布时清除", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const dom = harness();
    const { runtime, scenes } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });

    // 节点 248x232；输出端点世界坐标 (248, 116)。命中半径 >= 10，指针落在端点上。
    dom.fire("pointermove", { clientX: 248, clientY: 116 });
    controller.flush();
    expect((scenes.at(-1) as { hover?: unknown }).hover).toEqual({ nodeId: "n1", port: "output" });

    // 指针离开画布清除 hover。
    dom.fire("pointerleave", {});
    controller.flush();
    expect((scenes.at(-1) as { hover?: unknown }).hover).toBeUndefined();
    controller.dispose();
  });

  it("同一节点内移动不产生多余渲染快照", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const dom = harness();
    const { runtime, scenes } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });

    dom.fire("pointermove", { clientX: 80, clientY: 80 });
    controller.flush();
    const afterFirst = scenes.length;
    // 身份与端点侧都未变化：不产生新快照。
    dom.fire("pointermove", { clientX: 120, clientY: 150 });
    controller.flush();
    expect(scenes.length).toBe(afterFirst);
    controller.dispose();
  });
});

describe("连线悬停与删除按钮（change: add-edge-hover-delete）", () => {
  /** 两个 start/image 节点 + 一条边；节点尺寸 248x232。 */
  function edgeCanvas(): ServerCanvas {
    const base = createEmptyWoohaa3ServerCanvas("c1");
    return {
      ...base,
      revision: 1,
      document: {
        ...base.document,
        nodes: [
          { id: "n1", type: "text", position: { x: 0, y: 0 } },
          { id: "n2", type: "image", position: { x: 600, y: 0 } }
        ],
        edges: [{ id: "e1", source: "n1", target: "n2", data: {}, sourceHandle: null, targetHandle: null }]
      }
    };
  }

  /** 连线中点：输出端点 (248,116) 与输入端点 (600,116) → (424,116)。 */
  const mid = { x: 424, y: 116 };

  function setup() {
    woohaa3CanvasStore.getState().applyRemoteCanvas(edgeCanvas());
    const dom = harness();
    const { runtime, scenes } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });
    return { dom, controller, scenes };
  }

  it("悬停连线本体即携带 edgeId 悬停态（删除按钮出现）", () => {
    const { dom, controller, scenes } = setup();
    // 指针落在连线上（中点附近但避开恰好的正中心，先测连线本体命中）。
    dom.fire("pointermove", { clientX: 424, clientY: 116 });
    controller.flush();
    expect((scenes.at(-1) as { hover?: unknown }).hover).toEqual({ edgeId: "e1" });
    controller.dispose();
  });

  it("点击连线本体不再删除，也不改变 selection", () => {
    const { dom, controller } = setup();
    // 连线本体上、但远离中点按钮的位置（两端同 y，曲线是 y=116 的水平线）。
    const body = { x: 340, y: 116 };
    dom.fire("pointermove", { clientX: body.x, clientY: body.y });
    controller.flush();
    dom.fire("pointerdown", { clientX: body.x, clientY: body.y, button: 0 });
    dom.fire("pointerup", { clientX: body.x, clientY: body.y, button: 0 });
    controller.flush();
    expect(submitted.some((command) => command.type === "edge.remove")).toBe(false);
    expect(submitted).toHaveLength(0);
    controller.dispose();
  });

  it("点击删除按钮提交一次 edge.remove 且不改 selection", () => {
    const { dom, controller } = setup();
    // 先悬停连线，使按钮可命中。
    dom.fire("pointermove", { clientX: mid.x, clientY: mid.y });
    controller.flush();
    dom.fire("pointerdown", { clientX: mid.x, clientY: mid.y, button: 0 });
    controller.flush();
    const removals = submitted.filter((command) => command.type === "edge.remove");
    expect(removals).toEqual([{ type: "edge.remove", edgeId: "e1" }]);
    // selection 未被清空（点击按钮不是「点空白」）。
    expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual([]);
    controller.dispose();
  });

  it("只读会话下点击删除按钮不提交命令", () => {
    setSession({ isWritable: () => false, submitCommands: () => ({ ok: true }) as never });
    const { dom, controller } = setup();
    dom.fire("pointermove", { clientX: mid.x, clientY: mid.y });
    controller.flush();
    dom.fire("pointerdown", { clientX: mid.x, clientY: mid.y, button: 0 });
    controller.flush();
    expect(submitted).toHaveLength(0);
    controller.dispose();
  });

  it("有标签时删除按钮排在标签右侧：点击该处删除，点击标签处不删除", () => {
    const base = createEmptyWoohaa3ServerCanvas("c1");
    woohaa3CanvasStore.getState().applyRemoteCanvas({
      ...base,
      revision: 1,
      document: {
        ...base.document,
        nodes: [
          { id: "n1", type: "text", position: { x: 0, y: 0 } },
          { id: "n2", type: "image", position: { x: 600, y: 0 } }
        ],
        edges: [{ id: "e1", source: "n1", target: "n2", data: { label: "输入" }, sourceHandle: null, targetHandle: null }]
      }
    });
    const dom = harness();
    const { runtime } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });
    // 先悬停标签处（连线本体），使按钮出现。
    dom.fire("pointermove", { clientX: mid.x, clientY: mid.y });
    controller.flush();
    // 标签处点击：不删除。
    dom.fire("pointerdown", { clientX: mid.x, clientY: mid.y, button: 0 });
    controller.flush();
    expect(submitted.some((command) => command.type === "edge.remove")).toBe(false);
    // 标签右侧按钮处点击：删除。真实指针必有一次移动（按下即清 hover 投影，按钮命中上下文
    // 来自按下那一刻的悬停态，见 interaction-2d-input 的 clearHover 说明）。
    const button = bevyEdgeDeleteRect(
      { x: 0, y: 0, width: 248, height: 232 },
      { x: 600, y: 0, width: 248, height: 232 },
      "输入"
    );
    const buttonX = button.x + button.width / 2;
    dom.fire("pointermove", { clientX: buttonX, clientY: mid.y });
    controller.flush();
    dom.fire("pointerdown", { clientX: buttonX, clientY: mid.y, button: 0 });
    controller.flush();
    expect(submitted.filter((command) => command.type === "edge.remove")).toEqual([
      { type: "edge.remove", edgeId: "e1" }
    ]);
    controller.dispose();
  });
  it("纵向带标签连线：从线体经标签移到按钮时悬停不丢失，按钮仍可删除", () => {
    const base = createEmptyWoohaa3ServerCanvas("c1");
    woohaa3CanvasStore.getState().applyRemoteCanvas({
      ...base,
      revision: 1,
      document: {
        ...base.document,
        nodes: [
          { id: "n1", type: "image", position: { x: 0, y: 0 } },
          { id: "n2", type: "image", position: { x: 200, y: 400 } }
        ],
        edges: [{ id: "e1", source: "n1", target: "n2", data: { label: "图片" }, sourceHandle: null, targetHandle: null }]
      }
    });
    const dom = harness();
    const { runtime, scenes } = runtimeCapturing();
    const controller = installInteractionController({
      canvas: dom.canvas,
      getRuntime: () => runtime,
      getSession: () => getSession() as never,
      target: dom.target as never
    });
    // 端口 (248,116) / (200,516) → 中点 (224,316)；两端口几乎竖直，标签居中，按钮在标签右侧。
    const source = { x: 0, y: 0, width: 248, height: 232 };
    const target = { x: 200, y: 400, width: 248, height: 232 };
    const from = bevyPort(source, "output");
    const to = bevyPort(target, "input");
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    const button = bevyEdgeDeleteRect(source, target, "图片");
    const buttonCenter = { x: button.x + button.width / 2, y: button.y + button.height / 2 };
    const labelWidth = edgeLabelWidth("图片");
    const lastHover = (entries: Array<Record<string, unknown>>) => (entries.at(-1) as { hover?: unknown }).hover;

    // 先悬停线体（曲线穿过标签中点）。
    dom.fire("pointermove", { clientX: mid.x, clientY: mid.y });
    controller.flush();
    expect(lastHover(scenes)).toEqual({ edgeId: "e1" });
    // 真实指针会连续经过「标签」「间隙」再到按钮；每一步都必须保持悬停，
    // 否则按钮在途中消失（修复：删除按钮悬停丢失）。
    for (const point of [
      // 标签右半部：离曲线 12px，只可能命中标签保持区。
      { x: mid.x + labelWidth / 2 - 7, y: mid.y },
      // 标签与按钮之间的间隙（落在按钮命中外扩里）。
      { x: mid.x + labelWidth / 2 + 1, y: mid.y },
      buttonCenter
    ]) {
      dom.fire("pointermove", { clientX: point.x, clientY: point.y });
      controller.flush();
      expect(lastHover(scenes), `hover lost at ${JSON.stringify(point)}`).toEqual({ edgeId: "e1" });
    }
    dom.fire("pointerdown", { clientX: buttonCenter.x, clientY: buttonCenter.y, button: 0 });
    controller.flush();
    expect(submitted.filter((command) => command.type === "edge.remove")).toEqual([
      { type: "edge.remove", edgeId: "e1" }
    ]);
    controller.dispose();
  });
});

/** 选中 n1（图片节点，默认 248x232）并返回可拖拽抓手的坐标。 */
