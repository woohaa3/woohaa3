/**
 * store 级测试：规范聚合的提交边界与「Yjs 派生 facade」语义。
 *
 * Yjs 是唯一事实源，store 不再有本地持久化、undo 历史或仓储注入。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, createWoohaa3CanvasNode, type ServerCanvas } from "@woohaa3/contracts";
import { canvasGraphOfState, woohaa3CanvasStore } from "./canvas-store.js";

const NOW = "2026-09-22T12:00:00.000Z";
const LATER = "2026-09-22T12:00:05.000Z";

function freshCanvas(): ServerCanvas {
  return createEmptyWoohaa3ServerCanvas("canvas-store-test", NOW);
}

function seed(canvas: ServerCanvas = freshCanvas()): ServerCanvas {
  woohaa3CanvasStore.getState().hydrate(canvas);
  return canvas;
}

describe("提交路径", () => {
  it("未 hydrate 时拒绝变更并给出结构化原因", () => {
    woohaa3CanvasStore.setState({ canvas: null, lastRejection: null });
    const result = woohaa3CanvasStore.getState().moveNodes({ "node-x": { x: 1, y: 1 } });
    expect(result.ok).toBe(false);
    expect(woohaa3CanvasStore.getState().lastRejection?.code).toBe("unknown-node");
    expect(woohaa3CanvasStore.getState().canvas).toBeNull();
  });

  it("新增/移动节点后 store 持有规范画布，投影随之更新", () => {
    seed();
    const added = woohaa3CanvasStore.getState().addNode(
      createWoohaa3CanvasNode("image", { x: 0, y: 0 }, "node-image"),
      { panelPrompt: "一只猫" },
      NOW
    );
    expect(added.ok).toBe(true);
    expect(woohaa3CanvasStore.getState().canvas?.revision).toBe(1);
    expect(canvasGraphOfState(woohaa3CanvasStore.getState())?.nodes).toHaveLength(1);

    woohaa3CanvasStore.getState().moveNodes({ "node-image": { x: 200, y: 100 } }, LATER);
    const canvas = woohaa3CanvasStore.getState().canvas;
    expect(canvas?.revision).toBe(2);
    expect(canvas?.document.nodes[0].position).toEqual({ x: 200, y: 100 });
    // nodeData 不被结构变更丢掉
    expect(canvas?.nodeData["node-image"]).toEqual({ panelPrompt: "一只猫" });
  });

  it("被拒绝的提交不改变 revision，并记录 lastRejection", () => {
    seed();
    woohaa3CanvasStore.getState().addNode(
      createWoohaa3CanvasNode("image", { x: 0, y: 0 }, "node-image"),
      undefined,
      NOW
    );
    const before = woohaa3CanvasStore.getState().canvas;

    const result = woohaa3CanvasStore.getState().connect({
      id: "edge-1",
      source: "node-image",
      target: "node-missing"
    }, LATER);

    expect(result.ok).toBe(false);
    expect(woohaa3CanvasStore.getState().lastRejection?.code).toBe("unknown-node");
    expect(woohaa3CanvasStore.getState().canvas).toBe(before);
    expect(woohaa3CanvasStore.getState().canvas?.revision).toBe(1);
  });

  it("无操作提交不递增 revision", () => {
    seed();
    woohaa3CanvasStore.getState().addNode(
      createWoohaa3CanvasNode("image", { x: 0, y: 0 }, "node-image"),
      undefined,
      NOW
    );
    woohaa3CanvasStore.getState().moveNodes({ "node-image": { x: 0, y: 0 } }, LATER);
    expect(woohaa3CanvasStore.getState().canvas?.revision).toBe(1);
  });

  it("nodeData 提交进入规范聚合（视口不在规范画布内）", () => {
    seed();
    woohaa3CanvasStore.getState().addNode(
      createWoohaa3CanvasNode("text", { x: 0, y: 0 }, "node-text"),
      undefined,
      NOW
    );
    woohaa3CanvasStore.getState().patchNodeData("node-text", { prompt: "提示词" }, LATER);

    const canvas = woohaa3CanvasStore.getState().canvas;
    expect(canvas?.document).not.toHaveProperty("viewport");
    expect(canvas?.nodeData["node-text"]).toEqual({ prompt: "提示词" });
    expect(canvas?.revision).toBe(2);
  });
});

describe("Yjs 派生 facade", () => {
  it("applyRemoteCanvas 直接替换规范画布（服务端唯一回流路径）", () => {
    seed();
    const derived: ServerCanvas = {
      ...freshCanvas(),
      revision: 7,
      document: {
        ...freshCanvas().document,
        nodes: [{ id: "n1", type: "text", position: { x: 1, y: 2 } }]
      }
    };
    woohaa3CanvasStore.getState().applyRemoteCanvas(derived);
    expect(woohaa3CanvasStore.getState().canvas).toBe(derived);
    expect(woohaa3CanvasStore.getState().canvas?.revision).toBe(7);
  });
});
