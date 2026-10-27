/**
 * working 结构与位置索引 / 拖动释放快路径
 * （change: 2026-10-10-optimize-canvas-interaction-hot-path，任务 5.1–5.3 / design D5）。
 *
 * 覆盖：
 * - 按 working canvas 身份缓存：相同对象复用，`applyRemoteCanvas` 产生新对象后重建；
 * - 嵌套父级绝对坐标用完整祖先链（不是只减直接父级）；
 * - `dragRoots` 过滤被祖先覆盖的后代；
 * - 释放无结构净变化只产生净位置命令（含父级相对坐标），无净变化返回空。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { createCanvasNodeIndex, sharedCanvasNodeIndex } from "./canvas-node-index.js";
import { createDragGestureFamily } from "./drag-gesture.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import type { InteractionCore } from "./interaction-core.js";

type NodeSpec = {
  id: string;
  type?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  parentId?: string;
};

function nodesCanvas(nodes: NodeSpec[]): ServerCanvas {
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
        ...(node.parentId !== undefined ? { parentId: node.parentId } : {})
      })),
      edges: []
    }
  };
}

describe("结构与位置索引缓存（design D5）", () => {
  it("相同 working 对象复用同一索引；新对象身份（远端/pending 变化）重建", () => {
    const first = nodesCanvas([{ id: "a", x: 10, y: 20 }, { id: "b", x: 30, y: 40 }]);
    const same = sharedCanvasNodeIndex(first);
    expect(same).not.toBeNull();
    // selection/pan 不替换 store 对象 → 命中缓存。
    expect(sharedCanvasNodeIndex(first)).toBe(same);

    const second = nodesCanvas([{ id: "a", x: 50, y: 20 }, { id: "b", x: 30, y: 40 }]);
    const rebuilt = sharedCanvasNodeIndex(second);
    expect(rebuilt).not.toBe(same);
    expect(rebuilt?.absolutePosition("a")).toEqual({ x: 50, y: 20 });
    // 单槽缓存：切回原对象会按其身份重建（不会错误复用第二个对象的表）。
    const back = sharedCanvasNodeIndex(first);
    expect(back?.absolutePosition("a")).toEqual({ x: 10, y: 20 });
  });

  it("嵌套父级绝对坐标使用完整祖先链，而非只减直接父级", () => {
    const index = createCanvasNodeIndex(
      nodesCanvas([
        { id: "outer", type: "group", x: 100, y: 200, width: 600, height: 600 },
        { id: "inner", type: "group", x: 10, y: 20, width: 400, height: 400, parentId: "outer" },
        { id: "leaf", x: 5, y: 7, width: 100, height: 80, parentId: "inner" }
      ])
    )!;
    // leaf 绝对 = 5+10+100, 7+20+200
    expect(index.absolutePosition("leaf")).toEqual({ x: 115, y: 227 });
    // 父级绝对 = inner = 110,220
    expect(index.parentAbsolutePosition("leaf")).toEqual({ x: 110, y: 220 });
    expect(index.parentAbsolutePosition("outer")).toEqual({ x: 0, y: 0 });
    expect(index.absolutePosition("missing")).toBeNull();
  });

  it("dragRoots 剔除被祖先覆盖的后代并保留绝对 origin", () => {
    const index = createCanvasNodeIndex(
      nodesCanvas([
        { id: "g", type: "group", x: 0, y: 0, width: 500, height: 500 },
        { id: "child", x: 40, y: 40, width: 100, height: 80, parentId: "g" },
        { id: "free", x: 800, y: 0 }
      ])
    )!;
    const origins = new Map([
      ["g", { x: 0, y: 0 }],
      ["child", { x: 40, y: 40 }],
      ["free", { x: 800, y: 0 }]
    ]);
    const roots = index.dragRoots(origins);
    expect([...roots.keys()].sort()).toEqual(["free", "g"]);
    expect(roots.get("g")).toEqual({ x: 0, y: 0 });
  });
});

describe("合并候选几何（mergeRectsByType / 任务 2.1）", () => {
  function mergeCanvas(nodes: NodeSpec[], data: Record<string, Record<string, unknown>> = {}): ServerCanvas {
    return { ...nodesCanvas(nodes), nodeData: data as ServerCanvas["nodeData"] };
  }

  it("按类型分桶：使用绝对坐标、有效尺寸与文档顺序", () => {
    const index = createCanvasNodeIndex(mergeCanvas([
      { id: "g", type: "group", x: 100, y: 200, width: 500, height: 400 },
      { id: "img-1", x: 10, y: 20, width: 200, height: 120, parentId: "g" },
      { id: "img-2", x: 300, y: 0 },
      { id: "m-1", type: "model3d", x: 0, y: 300, width: 200, height: 180 }
    ]))!;
    // 组内节点用完整祖先链换算出绝对坐标；未显式尺寸的回退到类型默认尺寸。
    expect(index.mergeRectsByType.get("image")).toEqual([
      { nodeId: "img-1", type: "image", x: 110, y: 220, width: 200, height: 120 },
      { nodeId: "img-2", type: "image", x: 300, y: 0, width: 248, height: 232 }
    ]);
    // 用户尺寸覆盖类型默认尺寸。
    expect(index.mergeRectsByType.get("model3d")).toEqual([
      { nodeId: "m-1", type: "model3d", x: 0, y: 300, width: 200, height: 180 }
    ]);
    // 组与复合资产不进入候选。
    expect(index.mergeRectsByType.has("group")).toBe(false);
    expect(index.mergeRectsByType.has("composite-asset")).toBe(false);
  });

  it("折叠组内的成员被排除，组本身从不入桶", () => {
    const index = createCanvasNodeIndex(mergeCanvas([
      { id: "g", type: "group", x: 0, y: 0, width: 400, height: 400 },
      { id: "child", x: 40, y: 40, width: 100, height: 100, parentId: "g" },
      { id: "free", x: 600, y: 0 }
    ], { g: { groupCollapsed: true } }))!;
    expect(index.mergeRectsByType.get("image")?.map(entry => entry.nodeId)).toEqual(["free"]);
  });

  it("托管节点与预览不进入候选", () => {
    const index = createCanvasNodeIndex(mergeCanvas([
      { id: "managed", x: 0, y: 0 },
      { id: "preview", type: "film-set-shot-preview", x: 300, y: 0 }
    ], {
      managed: {
        managedBy: {
          schemaVersion: 1, extensionId: "film-set", ownerNodeId: "owner",
          entityId: "entity", lifecycle: "owner-managed"
        }
      }
    }))!;
    expect(index.mergeRectsByType.size).toBe(0);
  });

  it("空画布没有候选桶", () => {
    const index = createCanvasNodeIndex(mergeCanvas([]))!;
    expect(index.mergeRectsByType.size).toBe(0);
  });
});

/** 构造只暴露 drag 族所需能力的最小 core。 */
function dragCore(submissions: unknown[]): Pick<InteractionCore, "state" | "submit" | "buildScene" | "schedule" | "clearHeldKeys"> {
  return {
    state: { gesture: { kind: "drag", pointerId: 1, start: { x: 0, y: 0 }, origins: new Map(), moved: true } },
    submit: (commands: readonly unknown[]) => { submissions.push(...commands); },
    buildScene: () => null,
    schedule: () => undefined,
    clearHeldKeys: () => undefined
  } as unknown as Pick<InteractionCore, "state" | "submit" | "buildScene" | "schedule" | "clearHeldKeys">;
}

describe("拖动释放净位置快路径（design D5）", () => {
  it("无重父化：直接生成净位置命令（顶层绝对坐标）", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(nodesCanvas([{ id: "a", x: 0, y: 0 }, { id: "b", x: 600, y: 0 }]));
    const submissions: Array<{ type: string; nodeId: string; position: { x: number; y: number } }> = [];
    const drag = createDragGestureFamily(dragCore(submissions));
    const previews = new Map([["a", { x: 100, y: 50 }]]);
    const commands = drag.dragDropCommands(new Map([["a", { x: 0, y: 0 }]]), previews) as typeof submissions;
    expect(commands).toEqual([{ type: "node.update", nodeId: "a", position: { x: 100, y: 50 } }]);
  });

  it("组内节点：位置命令换算为其父级相对坐标", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(
      nodesCanvas([
        { id: "g", type: "group", x: 100, y: 200, width: 400, height: 400 },
        { id: "m", x: 10, y: 20, width: 100, height: 80, parentId: "g" }
      ])
    );
    const submissions: Array<{ type: string; nodeId: string; position: { x: number; y: number } }> = [];
    const drag = createDragGestureFamily(dragCore(submissions));
    // 拖动 m 的绝对落点 (160, 260)（相对 g 即 60, 60）。
    const commands = drag.dragDropCommands(new Map([["m", { x: 110, y: 220 }]]), new Map([["m", { x: 160, y: 260 }]])) as typeof submissions;
    expect(commands).toEqual([{ type: "node.update", nodeId: "m", position: { x: 60, y: 60 } }]);
  });

  it("无净变化：不产生位置命令", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(nodesCanvas([{ id: "a", x: 0, y: 0 }]));
    const submissions: unknown[] = [];
    const drag = createDragGestureFamily(dragCore(submissions));
    const commands = drag.dragDropCommands(new Map([["a", { x: 0, y: 0 }]]), new Map([["a", { x: 0, y: 0 }]]));
    expect(commands).toEqual([]);
  });

  it("拖入 group：释放提交结构变化（parentId + group 自适应），仍走单批次结构规划", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(
      nodesCanvas([
        { id: "g", type: "group", x: 0, y: 0, width: 400, height: 400 },
        { id: "a", x: 600, y: 0, width: 100, height: 100 }
      ])
    );
    const submissions: unknown[] = [];
    const drag = createDragGestureFamily(dragCore(submissions));
    // 拖动 a 落到 group 内部（绝对落点 50,50 → 中心 100,100 在 group 框内）。
    const commands = drag.dragDropCommands(
      new Map([["a", { x: 600, y: 0 }]]),
      new Map([["a", { x: 50, y: 50 }]])
    ) as Array<{ type: string; nodeId: string; parentId?: string | null }>;
    const reparent = commands.find((command) => command.type === "node.update" && command.nodeId === "a");
    expect(reparent?.parentId).toBe("g");
  });

  it("拖出 group：释放以 null parentId 解除父子关系", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(
      nodesCanvas([
        { id: "g", type: "group", x: 0, y: 0, width: 400, height: 400 },
        { id: "a", x: 100, y: 100, width: 100, height: 100, parentId: "g" }
      ])
    );
    const submissions: unknown[] = [];
    const drag = createDragGestureFamily(dragCore(submissions));
    // a 原绝对 (100,100)，拖到 (800,800)（group 外）。
    const commands = drag.dragDropCommands(
      new Map([["a", { x: 100, y: 100 }]]),
      new Map([["a", { x: 800, y: 800 }]])
    ) as Array<{ type: string; nodeId: string; parentId?: string | null }>;
    const update = commands.find((command) => command.type === "node.update" && command.nodeId === "a");
    expect(update?.parentId).toBeNull();
  });
});

it("shares cached ancestor coordinates across sibling queries", () => {
  const canvas = nodesCanvas([
    { id: "root", type: "group", x: 10, y: 20 },
    { id: "parent", type: "group", parentId: "root", x: 3, y: 4 },
    { id: "left", parentId: "parent", x: 1, y: 2 },
    { id: "right", parentId: "parent", x: 5, y: 6 }
  ]);
  const index = createCanvasNodeIndex(canvas)!;
  expect(index.absolutePosition("left")).toEqual({ x: 14, y: 26 });
  const parent = index.absolutePosition("parent");
  expect(index.absolutePosition("right")).toEqual({ x: 18, y: 30 });
  expect(index.absolutePosition("parent")).toBe(parent);
  expect([...index.documentOrder]).toEqual([["root", 0], ["parent", 1], ["left", 2], ["right", 3]]);
});

it("does not cache a cyclic chain as a reusable ancestor base", () => {
  const index = createCanvasNodeIndex(nodesCanvas([
    { id: "a", parentId: "b", x: 1, y: 0 },
    { id: "b", parentId: "a", x: 10, y: 0 },
    { id: "leaf", parentId: "a", x: 100, y: 0 }
  ]))!;
  expect(index.absolutePosition("a")).toEqual({ x: 12, y: 0 });
  expect(index.absolutePosition("b")).toEqual({ x: 21, y: 0 });
  expect(index.absolutePosition("leaf")).toEqual({ x: 111, y: 0 });
});

it("derives receiver candidates once and invalidates on document replacement", () => {
  const canvas = nodesCanvas([
    { id: "ordinary", x: 0, y: 0 },
    { id: "receiver", type: "composite-asset", x: 1, y: 2 },
    { id: "group", type: "group", x: 3, y: 4 }
  ]);
  const index = sharedCanvasNodeIndex(canvas)!;
  expect(index.compositeNodes).toEqual([canvas.document.nodes[1]]);
  expect(sharedCanvasNodeIndex(canvas)!.compositeNodes).toBe(index.compositeNodes);
  const updated = { ...canvas, document: { ...canvas.document,
    nodes: canvas.document.nodes.filter(node => node.id !== "receiver") } };
  expect(sharedCanvasNodeIndex(updated)!.compositeNodes).toEqual([]);
});

it("caches nested group bounds in document order and invalidates resized containers", () => {
  const canvas = nodesCanvas([
    { id: "outer", type: "group", x: 100, y: 200, width: 600, height: 500 },
    { id: "inner", type: "group", parentId: "outer", x: 10, y: 20, width: 300, height: 200 }
  ]);
  const index = sharedCanvasNodeIndex(canvas)!;
  expect(index.groupBounds).toEqual([
    { id: "outer", x: 100, y: 200, width: 600, height: 500 },
    { id: "inner", x: 110, y: 220, width: 300, height: 200 }
  ]);
  const updated = { ...canvas, document: { ...canvas.document,
    nodes: canvas.document.nodes.map(node => node.id === "inner" ? { ...node, width: 400 } : node) } };
  expect(sharedCanvasNodeIndex(updated)!.groupBounds[1]!.width).toBe(400);
  expect(index.groupBounds[1]!.width).toBe(300);
});
