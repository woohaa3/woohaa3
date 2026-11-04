/**
 * 拖动辅助对齐线的宿主接线（\`alignment-guides\` 扩展注入策略）。
 *
 * 这里只验证宿主侧语义：没策略时完全不吸附、有策略时按返回的偏移落预览、候选排除被拖动后代、
 * 位移未超过阈值时不进入吸附、参考线只在内容变化时推进版本号。
 * 求解规则本身归扩展（\`extensions/alignment-guides/src/frontend/solver.test.ts\`）。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { createCanvasNodeIndex } from "./canvas-node-index.js";
import {
  ALIGNMENT_SNAP_THRESHOLD_PX,
  applyDragAlignment,
  collectAlignmentCandidates,
  movingNodeIds,
  resolveDragAlignmentSnap
} from "./alignment-snap.js";
import type { AlignmentSnapPolicy } from "../../contract/alignment-snap.js";

type NodeSpec = { id: string; x: number; y: number; width?: number; height?: number; parentId?: string; type?: string };

function canvasOf(nodes: NodeSpec[]): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  return {
    ...base,
    revision: 1,
    document: {
      ...base.document,
      nodes: nodes.map(node => ({
        id: node.id,
        type: node.type ?? "image",
        position: { x: node.x, y: node.y },
        ...(node.width === undefined ? {} : { width: node.width }),
        ...(node.height === undefined ? {} : { height: node.height }),
        ...(node.parentId === undefined ? {} : { parentId: node.parentId })
      })),
      edges: []
    }
  };
}

const roots = (ids: string[]) => new Map(ids.map(id => [id, { x: 0, y: 0 }] as const));

/** 假策略：固定偏移 + 一条参考线；`isEnabled=false` 时返回 null（模拟"策略说不吸附"）。 */
function fakePolicy(offset = { x: 3, y: 2 }, isEnabled = true): AlignmentSnapPolicy {
  return {
    resolve: input => isEnabled && input.candidates.length > 0
      ? {
          dx: offset.x,
          dy: offset.y,
          guides: [{ axis: "x", position: input.moving[0]!.x, start: 0, end: 100, kind: "center" }]
        }
      : null
  };
}

describe("resolveDragAlignmentSnap", () => {
  it("没有策略时不吸附也不出参考线", () => {
    const index = createCanvasNodeIndex(canvasOf([
      { id: "a", x: 0, y: 0, width: 100, height: 100 },
      { id: "b", x: 300, y: 400, width: 100, height: 100 }
    ]));
    const snap = resolveDragAlignmentSnap({
      policy: null, index, roots: roots(["a"]), dx: 297, dy: 0, zoom: 1
    });
    expect(snap).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it("把策略返回的偏移原样交给调用方，并带出参考线", () => {
    const index = createCanvasNodeIndex(canvasOf([
      { id: "a", x: 0, y: 0, width: 100, height: 100 },
      { id: "b", x: 300, y: 400, width: 100, height: 100 }
    ]));
    const snap = resolveDragAlignmentSnap({
      policy: fakePolicy({ x: -2, y: 5 }), index, roots: roots(["a"]), dx: 40, dy: 40, zoom: 1
    });
    expect(snap.dx).toBeCloseTo(-2);
    expect(snap.dy).toBeCloseTo(5);
    expect(snap.guides).toHaveLength(1);
  });

  it("位移还没超过阈值时保持完全跟手（不调用策略）", () => {
    const index = createCanvasNodeIndex(canvasOf([
      { id: "a", x: 0, y: 0, width: 100, height: 100 },
      { id: "b", x: 0, y: 300, width: 100, height: 100 }
    ]));
    let calls = 0;
    const policy: AlignmentSnapPolicy = {
      resolve: () => { calls += 1; return { dx: -5, dy: 0, guides: [] }; }
    };
    // 5px < 6px 阈值：完全不进入吸附，避免"移一点点就弹回原位"。
    expect(resolveDragAlignmentSnap({ policy, index, roots: roots(["a"]), dx: 5, dy: 0, zoom: 1 }))
      .toEqual({ dx: 0, dy: 0, guides: [] });
    expect(calls).toBe(0);
  });

  it("阈值按缩放换算：同样世界位移在放大后不再触发吸附", () => {
    const index = createCanvasNodeIndex(canvasOf([
      { id: "a", x: 0, y: 0, width: 100, height: 100 },
      { id: "b", x: 0, y: 300, width: 100, height: 100 }
    ]));
    const policy = fakePolicy({ x: 3, y: 0 });
    // 阈值 = 6px / zoom：zoom=1 时是 6 世界单位（位移 5 还没"真的拖起来"，保持跟手）；
    // zoom=2 时是 3 世界单位（同样的 5 世界单位已经是 10 屏幕像素，允许吸附）。
    expect(resolveDragAlignmentSnap({ policy, index, roots: roots(["a"]), dx: 5, dy: 0, zoom: 1 }).dx).toBeCloseTo(0);
    expect(resolveDragAlignmentSnap({ policy, index, roots: roots(["a"]), dx: 5, dy: 0, zoom: 2 }).dx).toBeCloseTo(3);
    expect(ALIGNMENT_SNAP_THRESHOLD_PX).toBeGreaterThan(0);
  });

  it("没有候选对象时不吸附", () => {
    const index = createCanvasNodeIndex(canvasOf([{ id: "a", x: 0, y: 0, width: 100, height: 100 }]));
    const snap = resolveDragAlignmentSnap({
      policy: fakePolicy(), index, roots: roots(["a"]), dx: 30, dy: 40, zoom: 1
    });
    expect(snap).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it("策略返回的非法数值被丢弃，不影响拖动坐标", () => {
    const index = createCanvasNodeIndex(canvasOf([
      { id: "a", x: 0, y: 0, width: 100, height: 100 },
      { id: "b", x: 300, y: 400, width: 100, height: 100 }
    ]));
    const snap = resolveDragAlignmentSnap({
      policy: { resolve: () => ({ dx: Number.NaN, dy: 2, guides: [{ axis: "x", position: Number.NaN, start: 0, end: 1, kind: "start" }] }) },
      index, roots: roots(["a"]), dx: 10, dy: 10, zoom: 1
    });
    expect(snap.dx).toBe(0);
    expect(snap.dy).toBe(2);
    expect(snap.guides).toHaveLength(0);
  });
});

describe("applyDragAlignment", () => {
  it("把参考线写回状态并只在变化时推进版本号", () => {
    const index = createCanvasNodeIndex(canvasOf([
      { id: "a", x: 0, y: 0, width: 100, height: 100 },
      { id: "b", x: 300, y: 400, width: 100, height: 100 }
    ]));
    const state = { alignmentGuides: [], alignmentGuidesVersion: 0 } as {
      alignmentGuides: import("../../contract/alignment-snap.js").AlignmentGuide[];
      alignmentGuidesVersion: number;
    };
    const policy = fakePolicy();
    const first = applyDragAlignment({ state, policy, index, roots: roots(["a"]), dx: 40, dy: 0, zoom: 1 });
    expect(first.dx).toBeCloseTo(43);
    expect(state.alignmentGuides.length).toBeGreaterThan(0);
    const version = state.alignmentGuidesVersion;
    const second = applyDragAlignment({ state, policy, index, roots: roots(["a"]), dx: 40, dy: 0, zoom: 1 });
    expect(second).toEqual(first);
    expect(state.alignmentGuidesVersion).toBe(version);
    applyDragAlignment({ state, policy: null, index, roots: roots(["a"]), dx: 40, dy: 0, zoom: 1 });
    expect(state.alignmentGuidesVersion).toBe(version + 1);
    expect(state.alignmentGuides).toHaveLength(0);
  });
});
