/**
 * 统一 Agent Plan 编译器测试
 * （change: add-agent-canvas-authoring-mcp，任务 4.1–4.6 / 5.3）。
 *
 * 覆盖 ref 解析、语义 create 编译、connect 边、placement 避让、prompt/kind 校验、
 * 确定性实体 ID 与 payload hash。
 */
import { describe, expect, it } from "vitest";
import { compileAgentPlanWithHash, hashText, type PlannerSnapshot } from "./planner.js";
import type { AgentPlanOperation } from "@woohaa3/contracts";

function snapshot(overrides: Partial<PlannerSnapshot> = {}): PlannerSnapshot {
  return {
    canvasId: "c1",
    revision: 3,
    nodes: [
      { id: "text-1", type: "text", position: { x: 0, y: 0 }, width: 248, height: 232 },
      { id: "img-1", type: "image", position: { x: 300, y: 0 }, width: 248, height: 232 }
    ],
    edges: [],
    ...overrides
  };
}

async function compile(operations: AgentPlanOperation[], snap = snapshot(), requestId = "req-1", scope: any = "apply_canvas_plan") {
  return compileAgentPlanWithHash({ canvasId: snap.canvasId, requestId, scope, operations, snapshot: snap });
}

describe("create_node 编译（任务 4.2）", () => {
  it("为每个语义 kind 生成 canonical node.add（表驱动）", async () => {
    const cases: Array<[string, string, number, number]> = [
      ["text", "text", 248, 232],
      ["image", "image", 248, 232],
      ["video", "video", 248, 232],
      ["audio", "audio", 248, 232],
      ["model", "model3d", 248, 232]
    ];
    for (const [kind, canonicalType, width, height] of cases) {
      const result = await compile([{ op: "create_node", ref: "n0", kind: kind as never, placement: { mode: "absolute", position: { x: 1000, y: 1000 } } }]);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.commands[0]).toMatchObject({ type: "node.add", node: { type: canonicalType, width, height } });
    }
  });

  it("任务节点带 taskKind/taskStatus，模型节点不带", async () => {
    const image = await compile([{ op: "create_node", ref: "n0", kind: "image", placement: { mode: "absolute", position: { x: 1000, y: 0 } } }]);
    if (!image.ok) throw new Error("expected ok");
    expect((image.commands[0] as { nodeData?: Record<string, unknown> }).nodeData).toMatchObject({ taskKind: "image-generation", taskStatus: "idle" });
    const model = await compile([{ op: "create_node", ref: "n0", kind: "model", placement: { mode: "absolute", position: { x: 1000, y: 0 } } }]);
    if (!model.ok) throw new Error("expected ok");
    const data = (model.commands[0] as { nodeData?: Record<string, unknown> }).nodeData;
    expect(data?.taskKind).toBeUndefined();
    expect(data?.modelScript).toBeTruthy();
    expect(data?.modelContentVersion).toBeDefined();
  });

  it("实体 ID 确定性：相同 canvas/requestId/ref 得到同一 ID", async () => {
    const first = await compile([{ op: "create_node", ref: "n0", kind: "image", placement: { mode: "absolute", position: { x: 1000, y: 0 } } }]);
    const second = await compile([{ op: "create_node", ref: "n0", kind: "image", placement: { mode: "absolute", position: { x: 1000, y: 0 } } }]);
    if (!first.ok || !second.ok) throw new Error("expected ok");
    expect(first.refs["n0"]).toBe(second.refs["n0"]);
  });

  it("不同 requestId 产生不同实体 ID（新意图）", async () => {
    const first = await compile([{ op: "create_node", ref: "n0", kind: "image", placement: { mode: "absolute", position: { x: 1000, y: 0 } } }], snapshot(), "req-1");
    const second = await compile([{ op: "create_node", ref: "n0", kind: "image", placement: { mode: "absolute", position: { x: 1000, y: 0 } } }], snapshot(), "req-2");
    if (!first.ok || !second.ok) throw new Error("expected ok");
    expect(first.refs["n0"]).not.toBe(second.refs["n0"]);
  });
});

describe("connect 编译（任务 4.3）", () => {
  it("生成确定性 edgeId 且不接受调用方 edge 参数", async () => {
    const result = await compile([
      { op: "connect", ref: "e0", from: { nodeId: "text-1" }, to: { nodeId: "img-1" } }
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands[0]).toEqual({ type: "edge.add", edge: { id: result.refs["e0"], source: "text-1", target: "img-1" } });
  });

  it("拒绝自连接与重复边", async () => {
    const self = await compile([{ op: "connect", ref: "e0", from: { nodeId: "text-1" }, to: { nodeId: "text-1" } }]);
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.error.code).toBe("invalid-connection");
    const dup = await compile(
      [{ op: "connect", ref: "e0", from: { nodeId: "text-1" }, to: { nodeId: "img-1" } }],
      snapshot({ edges: [{ id: "existing", source: "text-1", target: "img-1" }] })
    );
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe("duplicate-edge");
  });

  it("可连接同计划中新建的节点（ref → canonical ID）", async () => {
    const result = await compile([
      { op: "create_node", ref: "t", kind: "text", placement: { mode: "absolute", position: { x: 2000, y: 0 } } },
      { op: "create_node", ref: "i", kind: "image", placement: { mode: "absolute", position: { x: 2400, y: 0 } } },
      { op: "connect", ref: "e0", from: { ref: "t" }, to: { ref: "i" } }
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const edge = result.commands.find((command) => command.type === "edge.add") as { edge: { source: string; target: string } };
    expect(edge.edge.source).toBe(result.refs["t"]);
    expect(edge.edge.target).toBe(result.refs["i"]);
  });
});

describe("引用解析（任务 4.1）", () => {
  it("未知 ref 报错并定位", async () => {
    const result = await compile([{ op: "set_prompt", target: { ref: "nope" }, prompt: "x" }]);
    expect(result).toMatchObject({ ok: false, error: { code: "unknown-ref", operationIndex: 0, field: "target" } });
  });

  it("前向 ref 报错", async () => {
    const result = await compile([
      { op: "set_prompt", target: { ref: "later" }, prompt: "x" },
      { op: "create_node", ref: "later", kind: "text", placement: { mode: "absolute", position: { x: 3000, y: 0 } } }
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unknown-ref");
  });

  it("重复 ref 报错", async () => {
    const result = await compile([
      { op: "create_node", ref: "n", kind: "text", placement: { mode: "absolute", position: { x: 3000, y: 0 } } },
      { op: "create_node", ref: "n", kind: "image", placement: { mode: "absolute", position: { x: 3400, y: 0 } } }
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("duplicate-ref");
  });

  it("引用不存在的 nodeId 报错", async () => {
    const result = await compile([{ op: "set_prompt", target: { nodeId: "ghost" }, prompt: "x" }]);
    expect(result).toMatchObject({ ok: false, error: { code: "unknown-node" } });
  });
});

describe("placement（任务 4.4）", () => {
  it("after placement 放在锚点右侧并避让", async () => {
    const result = await compile([{ op: "create_node", ref: "n", kind: "image", placement: { mode: "after", anchor: { nodeId: "img-1" } } }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = (result.commands[0] as { node: { position: { x: number; y: number } } }).node;
    expect(node.position.x).toBeGreaterThanOrEqual(300 + 248);
  });

  it("auto placement 使用图边界且避开已占用矩形", async () => {
    const result = await compile([{ op: "create_node", ref: "n", kind: "text", placement: { mode: "auto" } }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const position = (result.commands[0] as { node: { position: { x: number } } }).node.position;
    expect(position.x).toBeGreaterThanOrEqual(300 + 248);
  });

  it("absolute placement 保留合法坐标", async () => {
    const result = await compile([{ op: "create_node", ref: "n", kind: "text", placement: { mode: "absolute", position: { x: 5000, y: 6000 } } }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.commands[0] as { node: { position: { x: number; y: number } } }).node.position).toEqual({ x: 5000, y: 6000 });
  });
});

describe("prompt 与 delete（任务 4.5 / 5.3）", () => {
  it("set_prompt 只写 prompt 字段", async () => {
    const result = await compile([{ op: "set_prompt", target: { nodeId: "img-1" }, prompt: "draw" }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands).toEqual([{ type: "nodeData.patch", nodeId: "img-1", value: { prompt: "draw" } }]);
  });

  it("delete 编译为一条 node.remove", async () => {
    const result = await compile([{ op: "delete", targets: [{ nodeId: "img-1" }] }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands).toEqual([{ type: "node.remove", nodeIds: ["img-1"] }]);
  });

  it("抽取局部前置条件并附加到编译结果", async () => {
    const result = await compile([
      { op: "set_prompt", target: { nodeId: "img-1" }, prompt: "draw", if: { type: "prompt-equals", nodeId: "img-1", equals: "old" } }
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preconditions).toEqual([{ type: "prompt-equals", nodeId: "img-1", equals: "old" }]);
  });
});

describe("payload hash（任务 4.6）", () => {
  it("相同 plan 得到相同 hash；不同 operations 不同", async () => {
    const operations: AgentPlanOperation[] = [{ op: "set_prompt", target: { nodeId: "img-1" }, prompt: "draw" }];
    const a = await compile(operations, snapshot(), "req-1", "apply_canvas_plan");
    const b = await compile(operations, snapshot(), "req-2", "apply_canvas_plan");
    const c = await compile([{ op: "set_prompt", target: { nodeId: "img-1" }, prompt: "other" }], snapshot(), "req-1", "set_node_prompt");
    if (!a.ok || !b.ok || !c.ok) throw new Error("expected ok");
    // payload hash 只绑定 canvas + operations，不绑定 requestId/scope。
    expect(a.payloadHash).toBe(b.payloadHash);
    expect(a.payloadHash).not.toBe(c.payloadHash);
  });

  it("hashText 稳定", () => {
    expect(hashText("abc")).toBe(hashText("abc"));
    expect(hashText("abc")).not.toBe(hashText("abd"));
  });
});
