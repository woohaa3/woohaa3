// @vitest-environment jsdom
/**
 * 合并目标 DOM 高亮
 * （change: 2026-10-27-merge-same-type-node-history，任务 2.3 / design D2）。
 *
 * 覆盖：按目标 working 矩形 + worldToClient 定位、候选消失即移除、换算不可用时不回退、
 * 重复更新不产生 DOM mutation。
 */
import { afterEach, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import type { NodeMergeDrag } from "../../services/node-merge/index.js";
import { createNodeMergeOverlay, NODE_MERGE_OVERLAY_LABEL } from "./merge-overlay.js";

afterEach(() => document.body.replaceChildren());

function canvasOf(): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  return {
    ...base,
    revision: 1,
    document: {
      ...base.document,
      nodes: [
        { id: "source", type: "image", position: { x: 0, y: 0 }, width: 248, height: 232 },
        { id: "target", type: "image", position: { x: 300, y: 0 }, width: 248, height: 232 }
      ]
    }
  } as ServerCanvas;
}

const drag: NodeMergeDrag = {
  sourceNodeIds: ["source"],
  targetNodeId: "target",
  point: { x: 424, y: 116 }
};

const deps = { worldToClient: (point: { x: number; y: number }) => ({ x: point.x * 2, y: point.y * 2 }) };

it("按目标 working 矩形与 worldToClient 定位并展示提示", () => {
  const overlay = createNodeMergeOverlay(deps);
  overlay.update(canvasOf(), drag);
  const element = document.querySelector<HTMLElement>('[data-node-id="target"]')!;
  expect(element.className).toBe("node-merge-overlay");
  expect(element.style.left).toBe("600px");
  expect(element.style.top).toBe("0px");
  expect(element.style.width).toBe("496px");
  expect(element.style.height).toBe("464px");
  expect(element.textContent).toBe(NODE_MERGE_OVERLAY_LABEL);
});

it("候选消失或换算不可用时移除高亮（不猜测几何）", () => {
  const overlay = createNodeMergeOverlay(deps);
  const canvas = canvasOf();
  overlay.update(canvas, drag);
  overlay.update(canvas, null);
  expect(document.querySelector(".node-merge-overlays")).toBeNull();

  overlay.update(canvas, drag);
  overlay.clear();
  const unavailable = createNodeMergeOverlay({ worldToClient: () => null });
  const stale = createNodeMergeOverlay(deps);
  unavailable.update(canvas, drag);
  expect(document.querySelector(".node-merge-overlays")).toBeNull();

  // 目标被删除：更新画面后高亮消失。
  const withoutTarget = { ...canvas, document: { ...canvas.document,
    nodes: canvas.document.nodes.filter((node) => node.id !== "target") } } as ServerCanvas;
  stale.update(withoutTarget, drag);
  expect(document.querySelector(".node-merge-overlays")).toBeNull();
  stale.clear();
});

it("重复更新同一候选不产生 DOM 变更", () => {
  const overlay = createNodeMergeOverlay(deps);
  const canvas = canvasOf();
  overlay.update(canvas, drag);
  const observer = new MutationObserver(() => {});
  observer.observe(document.querySelector(".node-merge-overlays")!, {
    subtree: true, attributes: true, childList: true, characterData: true
  });
  overlay.update(canvas, drag);
  overlay.update(canvas, drag);
  expect(observer.takeRecords()).toHaveLength(0);
  observer.disconnect();
});
