/**
 * 拖动同类型节点合并的 gesture 裁决
 * （change: 2026-10-27-merge-same-type-node-history，任务 2.2 / design D1、D3）。
 *
 * 只直接驱动 `createDragGestureFamily`：候选来自共享索引的同类型桶，释放顺序固定为
 * 合并 → 片场 drop → 普通位置命令；这里锁住「命中消费释放」「无候选走普通移动」
 * 「多选/只读不提示」与两种 drop 的优先级。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeDrop } from "../../services/node-drop/index.js";
import { nodeMerge, type NodeMergeDrag } from "../../services/node-merge/index.js";
import type { InteractionCore } from "./interaction-core.js";
import type { Gesture } from "./interaction-types.js";
import { createDragGestureFamily } from "./drag-gesture.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

type NodeSpec = {
  id: string;
  type?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
};

function canvasOf(nodes: NodeSpec[]): ServerCanvas {
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
        width: node.width ?? 248,
        height: node.height ?? 232
      })),
      edges: []
    }
  };
}

function dragGesture(origins: Array<[string, { x: number; y: number }]>): Extract<Gesture, { kind: "drag" }> {
  return {
    kind: "drag",
    pointerId: 1,
    start: { x: 0, y: 0 },
    origins: new Map(origins),
    moved: true
  } as Extract<Gesture, { kind: "drag" }>;
}

function harness(options: { writable?: boolean } = {}) {
  const submissions: unknown[] = [];
  const state = {
    gesture: dragGesture([]),
    localPositions: new Map<string, { x: number; y: number }>(),
    dropTargetGroupIds: [],
    draft: null,
    localSizes: new Map(),
    lastPointerWorld: { x: 0, y: 0 },
    selected: [] as string[]
  };
  const core = {
    state,
    submit: (commands: readonly unknown[]) => { submissions.push(...commands); },
    buildScene: () => null,
    buildDragScene: () => null,
    schedule: () => undefined,
    clearHeldKeys: () => undefined,
    writable: () => options.writable ?? true
  } as unknown as Pick<
    InteractionCore,
    "state" | "submit" | "buildScene" | "buildDragScene" | "schedule" | "clearHeldKeys" | "writable"
  >;
  return { gesture: createDragGestureFamily(core), state, submissions };
}

describe("拖动合并候选（任务 2.2）", () => {
  it("命中同类型候选：evaluate 驱动 preview，释放消费且不提交位置命令", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasOf([
      { id: "source", x: 0, y: 0 },
      { id: "target", x: 300, y: 0 }
    ]));
    const { gesture, state, submissions } = harness();
    const preview = vi.fn();
    const drop = vi.fn((_drag: NodeMergeDrag) => true);
    const nodeDropDrop = vi.fn(() => true);
    cleanups.push(nodeMerge.bind({ preview, drop }), nodeDrop.bind({ preview: () => undefined, drop: nodeDropDrop }));

    const drag = dragGesture([["source", { x: 0, y: 0 }]]);
    state.gesture = drag;
    state.localPositions = new Map([["source", { x: 300, y: 0 }]]);
    gesture.evaluate();
    expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ sourceNodeIds: ["source"], targetNodeId: "target" }));

    gesture.commit(drag, new Map([["source", { x: 300, y: 0 }]]));
    expect(drop).toHaveBeenCalledTimes(1);
    // 合并优先于片场 drop：命中后不再分派接收方，也不提交源节点移动。
    expect(nodeDropDrop).not.toHaveBeenCalled();
    expect(submissions).toHaveLength(0);
    // 释放后清理高亮。
    expect(preview).toHaveBeenLastCalledWith(null);
  });

  it("无候选时回退普通移动并提交净位置命令", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasOf([
      { id: "source", x: 0, y: 0 },
      { id: "target", x: 1200, y: 0 }
    ]));
    const { gesture, state, submissions } = harness();
    const preview = vi.fn();
    const drop = vi.fn(() => true);
    cleanups.push(nodeMerge.bind({ preview, drop }));

    const drag = dragGesture([["source", { x: 0, y: 0 }]]);
    state.gesture = drag;
    state.localPositions = new Map([["source", { x: 800, y: 600 }]]);
    gesture.evaluate();
    expect(preview).toHaveBeenLastCalledWith(null);

    gesture.commit(drag, new Map([["source", { x: 800, y: 600 }]]));
    expect(drop).not.toHaveBeenCalled();
    expect(submissions).toContainEqual({ type: "node.update", nodeId: "source", position: { x: 800, y: 600 } });
  });

  it("多选拖动不提示合并", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasOf([
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 0, y: 300 },
      { id: "target", x: 300, y: 0 }
    ]));
    const { gesture, state, submissions } = harness();
    const preview = vi.fn();
    const drop = vi.fn(() => true);
    cleanups.push(nodeMerge.bind({ preview, drop }));

    const drag = dragGesture([["a", { x: 0, y: 0 }], ["b", { x: 0, y: 300 }]]);
    state.gesture = drag;
    state.localPositions = new Map([["a", { x: 300, y: 0 }], ["b", { x: 300, y: 300 }]]);
    gesture.evaluate();
    expect(preview).toHaveBeenLastCalledWith(null);

    gesture.commit(drag, state.localPositions);
    expect(drop).not.toHaveBeenCalled();
    expect(submissions.length).toBeGreaterThan(0);
  });

  it("只读会话不提示也不消费合并", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasOf([
      { id: "source", x: 0, y: 0 },
      { id: "target", x: 300, y: 0 }
    ]));
    const { gesture, state, submissions } = harness({ writable: false });
    const preview = vi.fn();
    const drop = vi.fn(() => true);
    cleanups.push(nodeMerge.bind({ preview, drop }));

    const drag = dragGesture([["source", { x: 0, y: 0 }]]);
    state.gesture = drag;
    state.localPositions = new Map([["source", { x: 300, y: 0 }]]);
    gesture.evaluate();
    expect(preview).toHaveBeenLastCalledWith(null);

    gesture.commit(drag, state.localPositions);
    expect(drop).not.toHaveBeenCalled();
    // 只读提交由会话层拦截；这里只断言没有合并消费。
    expect(submissions.every((command) => (command as { type?: string }).type !== "node.remove")).toBe(true);
  });

  it("合并未命中时片场 drop 仍然优先于普通移动", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasOf([
      { id: "source", x: 0, y: 0 },
      { id: "film", type: "composite-asset", x: 1200, y: 0 }
    ]));
    const { gesture, state, submissions } = harness();
    const mergeDrop = vi.fn(() => true);
    const dropPreview = vi.fn();
    const nodeDropDrop = vi.fn(() => true);
    cleanups.push(
      nodeMerge.bind({ preview: () => undefined, drop: mergeDrop }),
      nodeDrop.bind({ preview: dropPreview, drop: nodeDropDrop })
    );

    const drag = dragGesture([["source", { x: 0, y: 0 }]]);
    state.gesture = drag;
    state.localPositions = new Map([["source", { x: 1200, y: 0 }]]);
    gesture.commit(drag, state.localPositions);
    expect(mergeDrop).not.toHaveBeenCalled();
    expect(nodeDropDrop).toHaveBeenCalledTimes(1);
    expect(submissions).toHaveLength(0);
  });
});
