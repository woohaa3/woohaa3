/**
 * 渲染器中立命令规划器测试
 * （change: replace-godot-canvas-runtime-with-bevy，任务 5.1）。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GROUP_TITLE,
  planConnectEdge,
  planDeleteEdge,
  planDeleteNodes,
  planGroupNodes,
  planGroupedNodeUpdate,
  planInsertNode,
  planMoveNodes,
  planNodeDataPatch,
  planRefitGroups,
  planResizeNode,
  planArrangeGroupChildren,
  planTidyGroup,
  planUngroupNodes,
  aggregateOutputLeaves,
  planAggregateConnect,
  nodeAbsoluteRect
} from "../../extension-api/command-planner.js";
import type { Woohaa3CanvasNode } from "@woohaa3/contracts";

describe("command-planner", () => {
  it("plans a node.add", () => {
    const commands = planInsertNode({ nodeType: "text", position: { x: 1, y: 2 } });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: "node.add", node: { type: "text", position: { x: 1, y: 2 } } });
  });

  it("plans a connected node.add", () => {
    const commands = planInsertNode({ nodeType: "image", position: { x: 0, y: 0 }, connectFromNodeId: "n1", connectLabel: "输入" });
    expect(commands[0]).toMatchObject({
      type: "node.add",
      connect: { fromNodeId: "n1", label: "输入" }
    });
  });

  it("creates model3d nodes with embedded preview dimensions", () => {
    const commands = planInsertNode({ nodeType: "model3d", position: { x: 0, y: 0 } });
    expect(commands[0]).toMatchObject({
      type: "node.add",
      node: { type: "model3d", width: 248, height: 232 }
    });
  });

  it("preserves explicit model3d node dimensions", () => {
    const commands = planInsertNode({ nodeType: "model3d", position: { x: 0, y: 0 }, width: 240, height: 120 });
    expect(commands[0]).toMatchObject({ node: { width: 240, height: 120 } });
  });

  it("plans one node.update per moved node", () => {
    const commands = planMoveNodes({ a: { x: 1, y: 1 }, b: { x: 2, y: 2 } });
    expect(commands).toHaveLength(2);
    expect(commands).toEqual(expect.arrayContaining([{ type: "node.update", nodeId: "a", position: { x: 1, y: 1 } }]));
  });

  it("plans node.remove", () => {
    expect(planDeleteNodes(["a", "b"])).toEqual([{ type: "node.remove", nodeIds: ["a", "b"] }]);
  });

  it("plans edge.add / edge.remove", () => {
    const add = planConnectEdge({ source: "a", target: "b" });
    expect(add).toHaveLength(1);
    expect(add[0]).toMatchObject({
      type: "edge.add",
      edge: { source: "a", target: "b", sourceHandle: null, targetHandle: null }
    });
    // 客户端稳定 edgeId（change: add-frontend-speculative-canvas-state，design D7）。
    const edgeId = (add[0] as { edge: { id?: string } }).edge.id;
    expect(typeof edgeId).toBe("string");
    expect(edgeId!.length).toBeGreaterThan(0);
    expect(planDeleteEdge("e1")).toEqual([{ type: "edge.remove", edgeId: "e1" }]);
  });


  it("plans nodeData.patch", () => {
    expect(planNodeDataPatch({ nodeId: "n1", value: { prompt: "x" } })).toEqual([
      { type: "nodeData.patch", nodeId: "n1", value: { prompt: "x" } }
    ]);
  });

  it("plans node.update{width,height} for resize", () => {
    expect(planResizeNode({ nodeId: "n1", width: 320, height: 240 })).toEqual([
      { type: "node.update", nodeId: "n1", width: 320, height: 240 }
    ]);
  });
});

describe("group 结构命令规划（change: add-canvas-node-grouping，任务 1.3）", () => {
  function groupNode(): Woohaa3CanvasNode {
    return {
      id: "g",
      type: "group",
      position: { x: 0, y: 0 },
      width: 400,
      height: 300,
      data: {}
    };
  }

  it("planGroupNodes 产出单批次的 add + reparent + 标题", () => {
    const nodes: Woohaa3CanvasNode[] = [
      { id: "a", type: "image", position: { x: 100, y: 100 }, width: 200, height: 100, data: {} },
      { id: "b", type: "image", position: { x: 400, y: 300 }, width: 200, height: 100, data: {} }
    ];
    const commands = planGroupNodes(nodes, ["a", "b"]);
    // 一个 group add + 两个成员 update + 一个标题 patch，全部在同一批次。
    const add = commands.find((command) => command.type === "node.add");
    expect(add).toBeDefined();
    expect((add as { node: { type: string } }).node.type).toBe("group");
    const updates = commands.filter((command) => command.type === "node.update");
    expect(updates).toHaveLength(2);
    for (const update of updates) {
      expect((update as { parentId?: string | null }).parentId).toBe((add as { node: { id: string } }).node.id);
    }
    const patch = commands.find((command) => command.type === "nodeData.patch");
    expect(patch).toMatchObject({ nodeId: (add as { node: { id: string } }).node.id, value: { title: DEFAULT_GROUP_TITLE } });
  });

  it("planGroupNodes 少于两个节点时返回空批次", () => {
    expect(planGroupNodes([{ id: "a", type: "image", position: { x: 0, y: 0 }, data: {} }], ["a"])).toEqual([]);
  });

  it("planUngroupNodes 解散 group 为 remove + 成员 update(null)", () => {
    const nodes: Woohaa3CanvasNode[] = [
      groupNode(),
      { id: "a", type: "image", parentId: "g", position: { x: 20, y: 20 }, width: 200, height: 100, data: {} }
    ];
    const commands = planUngroupNodes(nodes, ["g"]);
    expect(commands.some((command) => command.type === "node.remove")).toBe(true);
    const update = commands.find((command) => command.type === "node.update") as { parentId?: string | null };
    expect(update.parentId).toBeNull();
  });

  it("planGroupedNodeUpdate 只为真正变化的节点产出命令", () => {
    const before: Woohaa3CanvasNode[] = [
      groupNode(),
      { id: "a", type: "image", parentId: "g", position: { x: 20, y: 20 }, width: 200, height: 100, data: {} }
    ];
    expect(planGroupedNodeUpdate(before, before)).toEqual([]);
    const after = before.map((node) => (node.id === "a" ? { ...node, position: { x: 30, y: 20 } } : node));
    expect(planGroupedNodeUpdate(before, after)).toEqual([
      { type: "node.update", nodeId: "a", position: { x: 30, y: 20 } }
    ]);
  });

  it("planRefitGroups 在几何未变时不产生命令", () => {
    const nodes: Woohaa3CanvasNode[] = [
      groupNode(),
      { id: "a", type: "image", parentId: "g", position: { x: 40, y: 40 }, width: 200, height: 100, data: {} }
    ];
    const commands = planRefitGroups(nodes, ["g"]);
    // 成员已在容器内且容器尺寸足够 → 无差异。
    expect(commands).toEqual([]);
  });

  it("nodeAbsoluteRect 用绝对坐标计算 group 矩形", () => {
    const nodes: Woohaa3CanvasNode[] = [
      { id: "g1", type: "group", position: { x: 100, y: 100 }, width: 400, height: 300, data: {} },
      { id: "g2", type: "group", parentId: "g1", position: { x: 50, y: 50 }, width: 100, height: 80, data: {} }
    ];
    expect(nodeAbsoluteRect(nodes[1]!, nodes)).toEqual({ x: 150, y: 150, width: 100, height: 80 });
  });

  it("planTidyGroup 只重排直接成员并收紧容器", () => {
    const nodes: Woohaa3CanvasNode[] = [
      { id: "g", type: "group", position: { x: 0, y: 0 }, width: 900, height: 700, data: {} },
      // a 入度 0（无入边），b 有来自 a 的入边。
      { id: "a", type: "image", parentId: "g", position: { x: 500, y: 500 }, width: 200, height: 100, data: {} },
      { id: "b", type: "image", parentId: "g", position: { x: 10, y: 10 }, width: 200, height: 100, data: {} }
    ];
    const commands = planTidyGroup(nodes, [{ source: "a", target: "b" }], "g");
    // a 排第一列、b 排第二列：两者位置都更新，且 a 在 b 左侧。
    const updates = commands.filter((c) => c.type === "node.update") as Array<{ nodeId: string; position?: { x: number; y: number } }>;
    const a = updates.find((u) => u.nodeId === "a")?.position;
    const b = updates.find((u) => u.nodeId === "b")?.position;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.x).toBeLessThan(b!.x);
    // 组外节点不在命令里。
    expect(commands.some((c) => c.type === "node.add" || c.type === "node.remove")).toBe(false);
  });

  it("planTidyGroup 对无成员的 group 返回空批次", () => {
    const nodes: Woohaa3CanvasNode[] = [{ id: "g", type: "group", position: { x: 0, y: 0 }, width: 400, height: 300, data: {} }];
    expect(planTidyGroup(nodes, [], "g")).toEqual([]);
  });

  it("planTidyGroup 对非 group id 返回空批次", () => {
    const nodes: Woohaa3CanvasNode[] = [{ id: "a", type: "image", position: { x: 0, y: 0 }, data: {} }];
    expect(planTidyGroup(nodes, [], "a")).toEqual([]);
  });

  describe("planArrangeGroupChildren", () => {
    const nodes: Woohaa3CanvasNode[] = [
      { id: "g", type: "group", position: { x: 0, y: 0 }, width: 900, height: 700, data: {} },
      { id: "a", type: "image", parentId: "g", position: { x: 500, y: 500 }, width: 200, height: 100, data: {} },
      { id: "b", type: "image", parentId: "g", position: { x: 10, y: 10 }, width: 200, height: 100, data: {} },
      { id: "outside", type: "image", position: { x: 800, y: 800 }, width: 200, height: 100, data: {} }
    ];
    const positions = (kind: Parameters<typeof planArrangeGroupChildren>[2]) => {
      const updates = planArrangeGroupChildren(nodes, "g", kind)
        .filter((command) => command.type === "node.update") as Array<{ nodeId: string; position?: { x: number; y: number } }>;
      return {
        a: updates.find((update) => update.nodeId === "a")?.position,
        b: updates.find((update) => update.nodeId === "b")?.position
      };
    };

    it("横排与竖排分别按单行、单列布局直接成员", () => {
      const horizontal = positions("arrange-horizontal");
      expect(horizontal.b!.y).toBe(horizontal.a!.y);
      expect(horizontal.b!.x).toBeLessThan(horizontal.a!.x);

      const vertical = positions("arrange-vertical");
      expect(vertical.b!.x).toBe(vertical.a!.x);
      expect(vertical.b!.y).toBeLessThan(vertical.a!.y);
      // 组外节点不进入批次。
      expect(planArrangeGroupChildren(nodes, "g", "arrange-horizontal").some((command) =>
        (command.type === "node.update" && command.nodeId === "outside") || command.type === "node.add" || command.type === "node.remove"
      )).toBe(false);
    });

    it("宫格按行优先排列", () => {
      const grid = positions("arrange-grid");
      expect(grid.b!.y).toBe(grid.a!.y);
      expect(grid.b!.x).toBeLessThan(grid.a!.x);
    });

    it("两种斜排方向相反", () => {
      const down = positions("arrange-diagonal-down");
      expect(down.a!.y).toBeGreaterThan(down.b!.y);
      expect(down.a!.x).toBeGreaterThan(down.b!.x);

      const up = positions("arrange-diagonal-up");
      expect(up.a!.y).toBeLessThan(up.b!.y);
      expect(up.a!.x).toBeGreaterThan(up.b!.x);
    });

    it("无成员或目标不是 group 时返回空批次", () => {
      expect(planArrangeGroupChildren([{ id: "g", type: "group", position: { x: 0, y: 0 }, data: {} }], "g", "arrange-grid")).toEqual([]);
      expect(planArrangeGroupChildren([{ id: "a", type: "image", position: { x: 0, y: 0 }, data: {} }], "a", "arrange-grid")).toEqual([]);
    });
  });

  it("aggregateOutputLeaves 递归展开叶子且顺序稳定", () => {
    const nodes: Woohaa3CanvasNode[] = [
      { id: "g1", type: "group", position: { x: 0, y: 0 }, width: 600, height: 600, data: {} },
      { id: "g2", type: "group", parentId: "g1", position: { x: 10, y: 10 }, width: 300, height: 300, data: {} },
      { id: "leaf", type: "image", parentId: "g2", position: { x: 0, y: 0 }, data: {} },
      { id: "b", type: "image", parentId: "g1", position: { x: 0, y: 100 }, data: {} }
    ];
    const a = aggregateOutputLeaves(nodes, "g1");
    const b = aggregateOutputLeaves(nodes, "g1");
    expect([...a].sort()).toEqual(["b", "leaf"]);
    expect(a).toEqual(b);
  });

  it("planAggregateConnect 为每个可连接叶子建真实边，不产生 group 边", () => {
    const nodes: Woohaa3CanvasNode[] = [
      { id: "g", type: "group", position: { x: 0, y: 0 }, width: 600, height: 400, data: {} },
      { id: "a", type: "image", parentId: "g", position: { x: 20, y: 20 }, data: {} },
      { id: "b", type: "image", parentId: "g", position: { x: 220, y: 20 }, data: {} },
      { id: "target", type: "text", position: { x: 900, y: 0 }, data: {} }
    ];
    const commands = planAggregateConnect(nodes, [], "g", "target");
    const edgeAdds = commands.filter((c) => c.type === "edge.add") as Array<{ edge: { source: string; target: string } }>;
    expect(edgeAdds).toHaveLength(2);
    expect(edgeAdds.map((e) => e.edge.source).sort()).toEqual(["a", "b"]);
    expect(edgeAdds.every((e) => e.edge.target === "target")).toBe(true);
    // 不存在 group -> target。
    expect(edgeAdds.some((e) => e.edge.source === "g")).toBe(false);
  });

  it("planAggregateConnect 跳过已有边（不重复连接）", () => {
    const nodes: Woohaa3CanvasNode[] = [
      { id: "g", type: "group", position: { x: 0, y: 0 }, width: 600, height: 400, data: {} },
      { id: "a", type: "image", parentId: "g", position: { x: 20, y: 20 }, data: {} },
      { id: "target", type: "text", position: { x: 900, y: 0 }, data: {} }
    ];
    const existing = [{ id: "e1", source: "a", target: "target", sourceHandle: null, targetHandle: null, data: {} }];
    expect(planAggregateConnect(nodes, existing, "g", "target")).toEqual([]);
  });

  it("planAggregateConnect 对无叶子的 group 返回空批次", () => {
    const nodes: Woohaa3CanvasNode[] = [
      { id: "g", type: "group", position: { x: 0, y: 0 }, width: 600, height: 400, data: {} },
      { id: "target", type: "text", position: { x: 900, y: 0 }, data: {} }
    ];
    expect(planAggregateConnect(nodes, [], "g", "target")).toEqual([]);
  });
});
