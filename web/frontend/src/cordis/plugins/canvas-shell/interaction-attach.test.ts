/**
 * 单节点拖动 Q/E 触碰粘连的控制器集成测试
 * （change: add-drag-touch-connections，任务 4.1 / design D1–D6）。
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

type NodeSpec = {
  id: string;
  type?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
};

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
        ...(node.height !== undefined ? { height: node.height } : {})
      })),
      edges: edges.map((edge) => ({ ...edge, sourceHandle: null, targetHandle: null, data: {} }))
    }
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
    ...options
  });
  return { dom, controller, scenes };
}

const lastAttach = (scenes: Array<Record<string, unknown>>) =>
  (scenes.at(-1) as { dragAttach?: unknown } | undefined)?.dragAttach;

/** owner a(0,0,248x232) 与右侧目标 b(x=230,0,248x232)；拖动 a 后触须可碰到 b。 */
function twoNodeCanvas(): ServerCanvas {
  return nodesCanvas([
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 230, y: 0 }
  ]);
}

describe("Q/E 方向与触须接触（design D2/D3）", () => {
  it("未越过移动阈值前不投影操作条", () => {
    const { dom, controller, scenes } = setup(twoNodeCanvas());
    dom.fire("pointerdown", { clientX: 100, clientY: 100 });
    controller.flush();
    expect(lastAttach(scenes)).toBeUndefined();
    controller.dispose();
  });

  it("按住 E 右侧触须接触合法节点：投影后序模式并锁定 owner -> target", () => {
    const { dom, controller, scenes } = setup(twoNodeCanvas());
    dom.fire("pointerdown", { clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 105, clientY: 100 });
    controller.flush();
    // 越过阈值但尚未按键：只有操作条，无触须/接触。
    expect(lastAttach(scenes)).toMatchObject({ nodeId: "a", mode: null, pendingEdges: [] });
    dom.fireKey("keydown", { code: "KeyE", key: "e" });
    controller.flush();
    expect(lastAttach(scenes)).toMatchObject({
      nodeId: "a",
      mode: "successor",
      contactNodeId: "b",
      pendingEdges: [{ source: "a", target: "b" }]
    });
    controller.dispose();
  });

  it("静止停止后按键立即求值接触（无需额外 pointermove）", () => {
    const { dom, controller, scenes } = setup(
      nodesCanvas([
        { id: "a", x: 300, y: 0 },
        { id: "b", x: 90, y: 0 }
      ])
    );
    dom.fire("pointerdown", { clientX: 400, clientY: 100 });
    dom.fire("pointermove", { clientX: 405, clientY: 100 });
    controller.flush();
    // 节点已停在目标旁；此时才按 Q。
    dom.fireKey("keydown", { code: "KeyQ", key: "q" });
    controller.flush();
    const attach = lastAttach(scenes) as { mode: string; contactNodeId?: string; pendingEdges: unknown[] };
    expect(attach.mode).toBe("predecessor");
    expect(attach.contactNodeId).toBe("b");
    expect(attach.pendingEdges).toHaveLength(1);
    controller.dispose();
  });

  it("两键交替按住：模式依次为前序、后序、前序、无", () => {
    const { dom, controller, scenes } = setup(twoNodeCanvas());
    dom.fire("pointerdown", { clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 105, clientY: 100 });
    dom.fireKey("keydown", { code: "KeyQ", key: "q" });
    controller.flush();
    expect((lastAttach(scenes) as { mode: string }).mode).toBe("predecessor");
    dom.fireKey("keydown", { code: "KeyE", key: "e" });
    controller.flush();
    expect((lastAttach(scenes) as { mode: string }).mode).toBe("successor");
    dom.fireKey("keyup", { code: "KeyE", key: "e" });
    controller.flush();
    expect((lastAttach(scenes) as { mode: string }).mode).toBe("predecessor");
    dom.fireKey("keyup", { code: "KeyQ", key: "q" });
    controller.flush();
    const attach = lastAttach(scenes) as { mode: string | null; pendingEdges: unknown[] };
    expect(attach.mode).toBeNull();
    // 已锁定的后序边保留（触须收回不撤销 pending）。
    expect(attach.pendingEdges).toHaveLength(1);
    controller.dispose();
  });

  it("key repeat（重复 keydown）不重复锁定同一条边", () => {
    const { dom, controller, scenes } = setup(twoNodeCanvas());
    dom.fire("pointerdown", { clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 105, clientY: 100 });
    dom.fireKey("keydown", { code: "KeyE", key: "e" });
    dom.fireKey("keydown", { code: "KeyE", key: "e", repeat: true });
    dom.fireKey("keydown", { code: "KeyE", key: "e", repeat: true });
    controller.flush();
    expect((lastAttach(scenes) as { pendingEdges: unknown[] }).pendingEdges).toHaveLength(1);
    controller.dispose();
  });
});

describe("释放时原子提交（design D4）", () => {
  it("移动并粘连后释放只调用一次 submit，位置与边同一批次", () => {
    const { dom, controller } = setup(twoNodeCanvas());
    dom.fire("pointerdown", { clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 130, clientY: 100 });
    dom.fireKey("keydown", { code: "KeyE", key: "e" });
    dom.fire("pointerup", { clientX: 130, clientY: 100 });
    controller.flush();
    const types = submitted.map((command) => command.type);
    expect(types.filter((type) => type === "node.update")).toHaveLength(1);
    expect(types.filter((type) => type === "edge.add")).toHaveLength(1);
    // 位置命令在边命令之前。
    expect(types.indexOf("node.update")).toBeLessThan(types.indexOf("edge.add"));
    // 中间 pointermove / 按键阶段不提交。
    const edge = submitted.find((command) => command.type === "edge.add") as Extract<CanvasCommand, { type: "edge.add" }>;
    expect(edge.edge).toMatchObject({ source: "a", target: "b" });
    controller.dispose();
  });

  it("回到原位释放只提交边，不提交无净变化的位置更新", () => {
    const { dom, controller } = setup(twoNodeCanvas());
    dom.fire("pointerdown", { clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 105, clientY: 100 });
    dom.fireKey("keydown", { code: "KeyE", key: "e" });
    // 移回起点再释放。
    dom.fire("pointermove", { clientX: 100, clientY: 100 });
    dom.fire("pointerup", { clientX: 100, clientY: 100 });
    controller.flush();
    expect(submitted.filter((command) => command.type === "node.update")).toHaveLength(0);
    expect(submitted.filter((command) => command.type === "edge.add")).toHaveLength(1);
    controller.dispose();
  });

  it("无净变化且无待提交边时不提交空批次", () => {
    const { dom, controller } = setup(twoNodeCanvas());
    dom.fire("pointerdown", { clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 100, clientY: 100 });
    dom.fire("pointerup", { clientX: 100, clientY: 100 });
    controller.flush();
    expect(submitted).toHaveLength(0);
    controller.dispose();
  });
});

describe("多目标与去重（design D3）", () => {
  it("一次后序拖动依次锁定多个目标，重复接触不新增", () => {
    const { dom, controller, scenes } = setup(
      nodesCanvas([
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 230, y: 0 },
        { id: "c", x: 230, y: 300 }
      ])
    );
    dom.fire("pointerdown", { clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 105, clientY: 100 });
    dom.fireKey("keydown", { code: "KeyE", key: "e" });
    controller.flush();
    // 触碰 b。
    let attach = lastAttach(scenes) as { pendingEdges: Array<{ target: string }> };
    expect(attach.pendingEdges.map((edge) => edge.target)).toEqual(["b"]);
    // 下移触碰 c。
    dom.fire("pointermove", { clientX: 105, clientY: 400 });
    controller.flush();
    attach = lastAttach(scenes) as { pendingEdges: Array<{ target: string }> };
    expect(attach.pendingEdges.map((edge) => edge.target).sort()).toEqual(["b", "c"]);
    // 回碰 b 不新增。
    dom.fire("pointermove", { clientX: 105, clientY: 100 });
    controller.flush();
    attach = lastAttach(scenes) as { pendingEdges: Array<{ target: string }> };
    expect(attach.pendingEdges).toHaveLength(2);
    controller.dispose();
  });
});

describe("门禁：多选 / group / 只读不提供粘连（design D1）", () => {
  it("多选拖动不显示操作条、不锁定边", () => {
    const { dom, controller, scenes } = setup(twoNodeCanvas());
    (dom.target as unknown as { __canvasSetSelection?: (ids: string[]) => void }).__canvasSetSelection?.(["a", "b"]);
    controller.flush();
    dom.fire("pointerdown", { clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 130, clientY: 100 });
    dom.fireKey("keydown", { code: "KeyE", key: "e" });
    controller.flush();
    expect(lastAttach(scenes)).toBeUndefined();
    dom.fire("pointerup", { clientX: 130, clientY: 100 });
    expect(submitted.filter((command) => command.type === "edge.add")).toHaveLength(0);
    controller.dispose();
  });


  it("只读会话拖动不提供粘连", () => {
    setSession({ isWritable: () => false, submitCommands: () => ({ ok: true }) as never });
    const { dom, controller, scenes } = setup(twoNodeCanvas(), { isWritable: () => false });
    dom.fire("pointerdown", { clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 105, clientY: 100 });
    dom.fireKey("keydown", { code: "KeyE", key: "e" });
    controller.flush();
    expect(lastAttach(scenes)).toBeUndefined();
    controller.dispose();
  });
});

describe("取消路径丢弃整次手势且不提交（design D6）", () => {
  function beginAttached(setupOptions: Record<string, unknown> = {}) {
    const ctx = setup(twoNodeCanvas(), setupOptions);
    ctx.dom.fire("pointerdown", { clientX: 100, clientY: 100 });
    ctx.dom.fire("pointermove", { clientX: 105, clientY: 100 });
    ctx.dom.fireKey("keydown", { code: "KeyE", key: "e" });
    ctx.controller.flush();
    return ctx;
  }

  it("Escape 取消：清预览、释放 capture、不提交", () => {
    const { dom, controller, scenes } = beginAttached();
    dom.fireKey("keydown", { code: "Escape", key: "Escape" });
    controller.flush();
    expect(lastAttach(scenes)).toBeUndefined();
    // 迟到 pointerup 不得提交。
    dom.fire("pointerup", { clientX: 105, clientY: 100 });
    controller.flush();
    expect(submitted).toHaveLength(0);
    controller.dispose();
  });

  it("pointercancel 走取消路径而非完成路径", () => {
    const { dom, controller } = beginAttached();
    dom.fire("pointercancel", { pointerId: 1 });
    controller.flush();
    expect(submitted).toHaveLength(0);
    controller.dispose();
  });

  it("窗口失焦取消未提交的粘连手势", () => {
    const { dom, controller } = beginAttached();
    dom.fire("blur", {});
    controller.flush();
    expect(submitted).toHaveLength(0);
    controller.dispose();
  });

  it("页面不可见取消未提交的粘连手势", () => {
    const { dom, controller } = beginAttached();
    dom.fire("visibilitychange", {});
    controller.flush();
    expect(submitted).toHaveLength(0);
    controller.dispose();
  });

  it("modal 从空变非空（cancelTransientGesture）取消手势且不提交", () => {
    const { dom, controller } = beginAttached();
    controller.cancelTransientGesture();
    controller.flush();
    dom.fire("pointerup", { clientX: 105, clientY: 100 });
    controller.flush();
    expect(submitted).toHaveLength(0);
    controller.dispose();
  });

  it("dispose 后迟到 pointerup 不提交", () => {
    const { dom, controller } = beginAttached();
    controller.dispose();
    dom.fire("pointerup", { clientX: 105, clientY: 100 });
    expect(submitted).toHaveLength(0);
  });

  it("拖动 owner 从 working canvas 消失时取消整次手势", () => {
    const { dom, controller, scenes } = beginAttached();
    // owner a 从 working 画布消失（远端删除 / 重基）。
    woohaa3CanvasStore.getState().applyRemoteCanvas(nodesCanvas([{ id: "b", x: 230, y: 0 }]));
    controller.flush();
    expect(lastAttach(scenes)).toBeUndefined();
    dom.fire("pointerup", { clientX: 105, clientY: 100 });
    controller.flush();
    expect(submitted).toHaveLength(0);
    controller.dispose();
  });
});

it("dragging a film set never exposes the attach bar or Q/E connection previews", () => {
  const { dom, controller, scenes } = setup(nodesCanvas([
    { id: "film", type: "composite-asset", x: 0, y: 0, width: 260, height: 195 },
    { id: "target", x: 230, y: 0 }
  ]));
  dom.fire("pointerdown", { clientX: 100, clientY: 100 });
  dom.fire("pointermove", { clientX: 130, clientY: 110 }); controller.flush();
  expect((scenes.at(-1) as any).nodes.find((node: any) => node.id === "film").x).toBe(30);
  expect(lastAttach(scenes)).toBeUndefined();
  dom.fireKey("keydown", { code: "KeyE", key: "e" }); controller.flush();
  expect(lastAttach(scenes)).toBeUndefined();
  dom.fire("pointerup", { clientX: 130, clientY: 110 });
  expect(submitted.flat().some(command => command.type === "edge.add")).toBe(false);
  controller.dispose();
});
