/**
 * 多选聚合拉线的控制器集成测试
 * （change: add-multi-select-aggregate-connect，任务 2.x / design D1–D6）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type CanvasCommand, type ServerCanvas } from "@woohaa3/contracts";
import { installInteractionController } from "./interaction-controller.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import {
  getSession, harness, installSharedSession, runtimeCapturing, setSession, submitted
} from "./test-support/controller-harness.js";

installSharedSession();
afterEach(() => {
  nodeSelectionStore.reset();
});

type NodeSpec = { id: string; type?: string; x: number; y: number; width?: number; height?: number; parentId?: string };

function nodesCanvas(nodes: NodeSpec[], edges: Array<{ id: string; source: string; target: string }> = []): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  return {
    ...base,
    revision: 1,
    document: {
      ...base.document,
      nodes: nodes.map((node) => ({
        id: node.id,
        type: node.type ?? "image",
        position: { x: node.x, y: node.y },
        ...(node.width !== undefined ? { width: node.width } : {}),
        ...(node.height !== undefined ? { height: node.height } : {}),
        ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
      })),
      edges: edges.map((edge) => ({ ...edge, sourceHandle: null, targetHandle: null, data: {} })),
    },
  };
}

function setup(canvasState: ServerCanvas, options: Record<string, unknown> = {}) {
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvasState);
  const dom = harness();
  const { runtime, scenes } = runtimeCapturing();
  const controller = installInteractionController({
    canvas: dom.canvas,
    getRuntime: () => runtime,
    getSession: () => getSession() as never,
    target: dom.target as never,
    ...options,
  });
  return { dom, controller, scenes };
}

const lastAggregate = (scenes: Array<Record<string, unknown>>) =>
  (scenes.at(-1) as { aggregateConnect?: unknown } | undefined)?.aggregateConnect;

function select(dom: ReturnType<typeof harness>, ids: string[]) {
  (dom.target as unknown as { __canvasSetSelection?: (ids: string[]) => void }).__canvasSetSelection?.(ids);
}

/**
 * 布局：a(0,0,200x120) b(0,300,200x120) 输出把手在 (218,210)，输入把手在 (-18,210)；
 * 目标 t(600,0,200x120)。
 */
function baseCanvas(): ServerCanvas {
  return nodesCanvas([
    { id: "a", x: 0, y: 0, width: 200, height: 120 },
    { id: "b", x: 0, y: 300, width: 200, height: 120 },
    { id: "t", x: 600, y: 0, width: 200, height: 120 },
  ]);
}

describe("把手显示与门禁（design D1）", () => {
  it("多选后投影聚合把手（direction null）", () => {
    const { dom, controller, scenes } = setup(baseCanvas());
    select(dom, ["a", "b"]);
    controller.flush();
    expect(lastAggregate(scenes)).toEqual({ direction: null, pendingEdges: [] });
    controller.dispose();
  });

  it("单选中不投影把手", () => {
    const { dom, controller, scenes } = setup(baseCanvas());
    select(dom, ["a"]);
    controller.flush();
    expect(lastAggregate(scenes)).toBeUndefined();
    controller.dispose();
  });

  it("单选 group 不投影聚合选区带，避免叠加第二条普通描边", () => {
    const canvasState = nodesCanvas([
      { id: "g", type: "group", x: 0, y: 0, width: 500, height: 400 },
      { id: "m1", x: 40, y: 40, width: 200, height: 120, parentId: "g" },
      { id: "m2", x: 40, y: 220, width: 200, height: 120, parentId: "g" },
    ]);
    const { dom, controller, scenes } = setup(canvasState);
    select(dom, ["g"]);
    controller.flush();
    expect(lastAggregate(scenes)).toBeUndefined();
    controller.dispose();
  });

  it("只读会话拖拽把手不提交（也不开始）", () => {
    setSession({ isWritable: () => false, submitCommands: () => ({ ok: true }) as never });
    const { dom, controller } = setup(baseCanvas(), { isWritable: () => false });
    select(dom, ["a", "b"]);
    controller.flush();
    dom.fire("pointerdown", { clientX: 218, clientY: 210 });
    dom.fire("pointermove", { clientX: 700, clientY: 60 });
    dom.fire("pointerup", { clientX: 700, clientY: 60 });
    controller.flush();
    expect(submitted).toHaveLength(0);
    controller.dispose();
  });
});

describe("输出把手批量提交（design D3/D4）", () => {
  it("从输出把手拖到目标：一次提交成员 -> 目标的两条边", () => {
    const { dom, controller, scenes } = setup(baseCanvas());
    select(dom, ["a", "b"]);
    controller.flush();
    dom.fire("pointerdown", { clientX: 218, clientY: 210 });
    dom.fire("pointermove", { clientX: 700, clientY: 60 });
    const preview = (lastAggregate(scenes) as { pendingEdges: unknown[] }).pendingEdges;
    expect(preview).toHaveLength(2);
    dom.fire("pointerup", { clientX: 700, clientY: 60 });
    controller.flush();
    const edges = submitted.filter((c) => c.type === "edge.add") as Array<Extract<CanvasCommand, { type: "edge.add" }>>;
    expect(edges).toHaveLength(2);
    expect(edges.map((c) => c.edge).map((e) => `${e.source}>${e.target}`).sort()).toEqual(["a>t", "b>t"]);
    controller.dispose();
  });

  it("从输入把手拖到目标：一次提交目标 -> 成员的两条边", () => {
    const { dom, controller } = setup(baseCanvas());
    select(dom, ["a", "b"]);
    controller.flush();
    dom.fire("pointerdown", { clientX: -18, clientY: 210 });
    dom.fire("pointermove", { clientX: 700, clientY: 60 });
    dom.fire("pointerup", { clientX: 700, clientY: 60 });
    controller.flush();
    const edges = submitted.filter((c) => c.type === "edge.add") as Array<Extract<CanvasCommand, { type: "edge.add" }>>;
    expect(edges.map((c) => c.edge).map((e) => `${e.source}>${e.target}`).sort()).toEqual(["t>a", "t>b"]);
    controller.dispose();
  });

  it("释放到空白或成员不提交", () => {
    const { dom, controller } = setup(baseCanvas());
    select(dom, ["a", "b"]);
    controller.flush();
    // 空白
    dom.fire("pointerdown", { clientX: 218, clientY: 210 });
    dom.fire("pointermove", { clientX: 999, clientY: 999 });
    dom.fire("pointerup", { clientX: 999, clientY: 999 });
    controller.flush();
    expect(submitted.filter((c) => c.type === "edge.add")).toHaveLength(0);
    // 成员
    dom.fire("pointerdown", { clientX: 218, clientY: 210 });
    dom.fire("pointermove", { clientX: 100, clientY: 60 });
    dom.fire("pointerup", { clientX: 100, clientY: 60 });
    controller.flush();
    expect(submitted.filter((c) => c.type === "edge.add")).toHaveLength(0);
    controller.dispose();
  });

  it("所有候选已有边时不提交空批次", () => {
    const canvasState = nodesCanvas(
      [
        { id: "a", x: 0, y: 0, width: 200, height: 120 },
        { id: "b", x: 0, y: 300, width: 200, height: 120 },
        { id: "t", x: 600, y: 0, width: 200, height: 120 },
      ],
      [{ id: "e1", source: "a", target: "t" }, { id: "e2", source: "b", target: "t" }],
    );
    const { dom, controller } = setup(canvasState);
    select(dom, ["a", "b"]);
    controller.flush();
    dom.fire("pointerdown", { clientX: 218, clientY: 210 });
    dom.fire("pointermove", { clientX: 700, clientY: 60 });
    dom.fire("pointerup", { clientX: 700, clientY: 60 });
    controller.flush();
    expect(submitted.filter((c) => c.type === "edge.add")).toHaveLength(0);
    controller.dispose();
  });
});

describe("取消路径（design D6）", () => {
  it("Escape 取消：清预览、不提交", () => {
    const { dom, controller } = setup(baseCanvas());
    select(dom, ["a", "b"]);
    controller.flush();
    dom.fire("pointerdown", { clientX: 218, clientY: 210 });
    dom.fire("pointermove", { clientX: 700, clientY: 60 });
    dom.fireKey("keydown", { code: "Escape", key: "Escape" });
    dom.fire("pointerup", { clientX: 700, clientY: 60 });
    controller.flush();
    expect(submitted).toHaveLength(0);
    controller.dispose();
  });

  it("pointercancel 走取消路径", () => {
    const { dom, controller } = setup(baseCanvas());
    select(dom, ["a", "b"]);
    controller.flush();
    dom.fire("pointerdown", { clientX: 218, clientY: 210 });
    dom.fire("pointermove", { clientX: 700, clientY: 60 });
    dom.fire("pointercancel", { pointerId: 1 });
    controller.flush();
    expect(submitted).toHaveLength(0);
    controller.dispose();
  });

  it("窗口失焦与页面不可见取消", () => {
    for (const event of ["blur", "visibilitychange"]) {
      const { dom, controller } = setup(baseCanvas());
      select(dom, ["a", "b"]);
      controller.flush();
      dom.fire("pointerdown", { clientX: 218, clientY: 210 });
      dom.fire("pointermove", { clientX: 700, clientY: 60 });
      dom.fire(event, {});
      controller.flush();
      expect(submitted).toHaveLength(0);
      controller.dispose();
    }
  });

  it("cancelTransientGesture 取消且迟到 pointerup 不提交", () => {
    const { dom, controller } = setup(baseCanvas());
    select(dom, ["a", "b"]);
    controller.flush();
    dom.fire("pointerdown", { clientX: 218, clientY: 210 });
    dom.fire("pointermove", { clientX: 700, clientY: 60 });
    controller.cancelTransientGesture();
    dom.fire("pointerup", { clientX: 700, clientY: 60 });
    controller.flush();
    expect(submitted).toHaveLength(0);
    controller.dispose();
  });

  it("成员全部从 working 消失时取消整次手势", () => {
    const { dom, controller } = setup(baseCanvas());
    select(dom, ["a", "b"]);
    controller.flush();
    dom.fire("pointerdown", { clientX: 218, clientY: 210 });
    dom.fire("pointermove", { clientX: 700, clientY: 60 });
    // a、b 从 working 消失。
    woohaa3CanvasStore.getState().applyRemoteCanvas(nodesCanvas([{ id: "t", x: 600, y: 0, width: 200, height: 120 }]));
    controller.flush();
    dom.fire("pointerup", { clientX: 700, clientY: 60 });
    controller.flush();
    expect(submitted).toHaveLength(0);
    controller.dispose();
  });
});
