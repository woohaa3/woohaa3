/**
 * Agent Canvas 协议 codec 契约测试
 * （change: add-agent-canvas-authoring-mcp，任务 1.3）。
 *
 * 覆盖：严格未知字段拒绝、limits、计划引用形式、错误定位（operationIndex/field）。
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_CANVAS_LIMITS,
  decodeAgentChangesQuery,
  decodeAgentGraphQuery,
  decodeAgentPlanOperations,
  decodeAgentRequestId
} from "./agent-canvas-protocol.js";

describe("Agent Canvas 计划解码（任务 1.3）", () => {
  it("解码 create/connect/set_prompt/move/delete 的合法计划", () => {
    const decoded = decodeAgentPlanOperations([
      { op: "create_node", ref: "t", kind: "text", prompt: "hi", placement: { mode: "absolute", position: { x: 1, y: 2 } } },
      { op: "create_node", ref: "i", kind: "image", placement: { mode: "after", anchor: { ref: "t" } } },
      { op: "connect", ref: "e1", from: { ref: "t" }, to: { ref: "i" } },
      { op: "set_prompt", target: { ref: "i" }, prompt: "draw" },
      { op: "move_node", target: { ref: "i" }, position: { x: 10, y: 20 } },
      { op: "delete", targets: [{ nodeId: "x" }] }
    ]);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.map((op) => op.op)).toEqual(["create_node", "create_node", "connect", "set_prompt", "move_node", "delete"]);
  });

  it("拒绝未知字段并定位", () => {
    const decoded = decodeAgentPlanOperations([{ op: "create_node", ref: "t", kind: "text", nodeData: {} }]);
    expect(decoded).toMatchObject({ ok: false, code: "malformed-request", operationIndex: 0, field: "nodeData" });
  });

  it("拒绝未知节点种类", () => {
    const decoded = decodeAgentPlanOperations([{ op: "create_node", ref: "t", kind: "gif" }]);
    expect(decoded).toMatchObject({ ok: false, code: "unsupported-node-kind", operationIndex: 0, field: "kind" });
  });

  it("实体引用必须且只能提供 ref 或 nodeId 之一", () => {
    expect(decodeAgentPlanOperations([{ op: "set_prompt", target: { ref: "a", nodeId: "b" }, prompt: "x" }]).ok).toBe(false);
    expect(decodeAgentPlanOperations([{ op: "set_prompt", target: {}, prompt: "x" }]).ok).toBe(false);
    expect(decodeAgentPlanOperations([{ op: "set_prompt", target: { nodeId: "b" }, prompt: "x" }]).ok).toBe(true);
  });

  it("absolute placement 拒绝非有限坐标", () => {
    const decoded = decodeAgentPlanOperations([
      { op: "create_node", ref: "t", kind: "text", placement: { mode: "absolute", position: { x: Number.NaN, y: 0 } } }
    ]);
    expect(decoded).toMatchObject({ ok: false, operationIndex: 0 });
  });

  it("不再按 prompt 长度或计划操作数拒绝（任务 5.1）", () => {
    // change: 2026-10-22-remove-agent-execution-limits：原 8000 字 prompt 与 256 操作总量门禁已删除。
    const longPrompt = decodeAgentPlanOperations([
      { op: "set_prompt", target: { nodeId: "n" }, prompt: "x".repeat(20_000) }
    ]);
    expect(longPrompt).toMatchObject({ ok: true });

    const many = decodeAgentPlanOperations(
      Array.from({ length: 400 }, (_value, index) => ({
        op: "set_prompt",
        target: { nodeId: `n-${index}` },
        prompt: "x"
      }))
    );
    expect(many).toMatchObject({ ok: true });
    if (many.ok) expect(many.value).toHaveLength(400);
  });

  it("前置条件类型受校验", () => {
    expect(
      decodeAgentPlanOperations([{ op: "set_prompt", target: { nodeId: "n" }, prompt: "x", if: { type: "prompt-equals", nodeId: "n", equals: "y" } }]).ok
    ).toBe(true);
    expect(
      decodeAgentPlanOperations([{ op: "set_prompt", target: { nodeId: "n" }, prompt: "x", if: { type: "nope", nodeId: "n" } }]).ok
    ).toBe(false);
  });
});

describe("Agent Canvas 查询解码（任务 1.3）", () => {
  it("graph 查询深度不再有应用上限，但仍拒绝非法值与未知字段", () => {
    // change: 2026-10-22-remove-agent-execution-limits，任务 4.2：深度是传输/邻域参数，不是额度。
    expect(decodeAgentGraphQuery({ aroundNodeId: "n", depth: AGENT_CANVAS_LIMITS.defaultNeighborhoodDepth }).ok).toBe(true);
    expect(decodeAgentGraphQuery({ aroundNodeId: "n", depth: 12 }).ok).toBe(true);
    expect(decodeAgentGraphQuery({ aroundNodeId: "n", depth: -1 }).ok).toBe(false);
    expect(decodeAgentGraphQuery({ nodeIds: ["a"], extra: 1 }).ok).toBe(false);
  });

  it("changes 查询要求 sinceRevision", () => {
    expect(decodeAgentChangesQuery({ sinceRevision: 0 }).ok).toBe(true);
    expect(decodeAgentChangesQuery({}).ok).toBe(false);
  });

  it("requestId 必须非空有界", () => {
    expect(decodeAgentRequestId("req-1").ok).toBe(true);
    expect(decodeAgentRequestId("").ok).toBe(false);
    expect(decodeAgentRequestId(undefined).ok).toBe(false);
  });
});
