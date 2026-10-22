/**
 * Agent 图投影与增量契约测试
 * （change: add-agent-canvas-authoring-mcp，任务 3.1–3.4）。
 *
 * 覆盖：安全白名单、语义 kind、affordances、邻域闭包、稳定分页、revision-bound cursor、
 * snapshot-stale 与增量等价。
 */
import { describe, expect, it } from "vitest";
import {
  buildAgentDelta,
  computeAgentDelta,
  decodeAgentCursor,
  encodeAgentCursor,
  projectAgentGraph,
  projectNodeAffordances
} from "./agent-canvas-projection.js";
import type { ServerCanvas } from "./domain/types.js";

function canvas(overrides: Partial<ServerCanvas> = {}): ServerCanvas {
  const base: ServerCanvas = {
    id: "c1",
    title: "画布",
    revision: 3,
    document: {
      schemaVersion: "asset-canvas-v1",
      updatedAt: "2026-09-28T00:00:00.000Z",
      nodes: [
        { id: "a", type: "text", position: { x: 0, y: 0 }, width: 248, height: 232 },
        { id: "b", type: "image", position: { x: 100, y: 0 }, width: 248, height: 232 },
        { id: "c", type: "model3d", position: { x: 200, y: 0 }, width: 196, height: 64 },
        { id: "d", type: "custom-widget", position: { x: 300, y: 0 } }
      ],
      edges: [
        { id: "e-ab", source: "a", target: "b", data: { label: "文本" } },
        { id: "e-bc", source: "b", target: "c", data: {} }
      ]
    },
    nodeData: {
      a: { prompt: "hello", taskKind: "text-generation", taskStatus: "idle" },
      b: { prompt: "draw", taskKind: "image-generation", taskStatus: "processing", progress: 0.5, activeRunId: "r1" },
      c: {},
      d: { secret: "should-not-leak" }
    },
    assets: [],
    jobs: [
      { id: "j1", nodeId: "a", taskId: "t", status: "running", updatedAt: "2026-09-28T00:00:00.000Z" }
    ],
    updatedAt: "2026-09-28T00:00:00.000Z"
  };
  return { ...base, ...overrides };
}

describe("Agent 图投影（任务 3.1）", () => {
  it("只暴露白名单字段，不泄漏 jobs/凭据/任意 nodeData", () => {
    const result = projectAgentGraph(canvas(), { includePrompt: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.graph);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("j1");
    expect(serialized).not.toContain("taskId");
    const nodeB = result.graph.nodes.find((node) => node.nodeId === "b");
    expect(nodeB).toMatchObject({ kind: "image", canonicalType: "image", prompt: "draw" });
    expect(nodeB?.task).toMatchObject({ taskStatus: "processing", progress: 0.5, runId: "r1" });
  });

  it("语义 kind 未知 canonical 类型回退为 null 并保留 canonicalType", () => {
    const result = projectAgentGraph(canvas());
    if (!result.ok) throw new Error("expected ok");
    const nodeD = result.graph.nodes.find((node) => node.nodeId === "d");
    expect(nodeD).toMatchObject({ kind: null, canonicalType: "custom-widget" });
  });

  it("includePrompt 控制 prompt 是否返回", () => {
    const without = projectAgentGraph(canvas());
    const withPrompt = projectAgentGraph(canvas(), { includePrompt: true });
    if (!without.ok || !withPrompt.ok) throw new Error("expected ok");
    expect(without.graph.nodes.find((n) => n.nodeId === "a")?.prompt).toBeUndefined();
    expect(withPrompt.graph.nodes.find((n) => n.nodeId === "a")?.prompt).toBe("hello");
  });

  it("输入摘要来自 edge 但不含资产 URL/storage key", () => {
    const result = projectAgentGraph(canvas());
    if (!result.ok) throw new Error("expected ok");
    const nodeB = result.graph.nodes.find((node) => node.nodeId === "b");
    expect(nodeB?.inputs).toEqual([{ sourceNodeId: "a", role: "reference_image" }]);
  });

  it("affordances 与描述符和 processing 状态一致（任务 3.3）", () => {
    expect(projectNodeAffordances("image", { taskStatus: "idle" })).toMatchObject({
      canSetPrompt: true,
      canRun: true,
      canConnect: true,
      canDelete: true
    });
    expect(projectNodeAffordances("image", { taskStatus: "processing" }).canRun).toBe(false);
    expect(projectNodeAffordances("model3d", {})).toMatchObject({ canRun: false, canSetPrompt: true });
    expect(projectNodeAffordances("custom-widget", {}).canConnect).toBe(false);
  });
});

describe("Agent 图读取过滤与分页（任务 3.2）", () => {
  it("邻域闭包只含中心与 depth 内邻居及其之间的边", () => {
    const result = projectAgentGraph(canvas(), { aroundNodeId: "b", depth: 1 });
    if (!result.ok) throw new Error("expected ok");
    expect(result.graph.nodes.map((node) => node.nodeId).sort()).toEqual(["a", "b", "c"]);
    expect(result.graph.edges.map((edge) => edge.edgeId).sort()).toEqual(["e-ab", "e-bc"]);
  });

  it("depth 0 只返回中心节点", () => {
    const result = projectAgentGraph(canvas(), { aroundNodeId: "b", depth: 0 });
    if (!result.ok) throw new Error("expected ok");
    expect(result.graph.nodes.map((node) => node.nodeId)).toEqual(["b"]);
    expect(result.graph.edges).toEqual([]);
  });

  it("nodeIds 选择裁剪边到所选集合", () => {
    const result = projectAgentGraph(canvas(), { nodeIds: ["a", "b"] });
    if (!result.ok) throw new Error("expected ok");
    expect(result.graph.nodes.map((node) => node.nodeId)).toEqual(["a", "b"]);
    expect(result.graph.edges.map((edge) => edge.edgeId)).toEqual(["e-ab"]);
  });

  it("稳定分页不重复不遗漏且 cursor 绑定 revision", () => {
    const first = projectAgentGraph(canvas(), { limit: 2 });
    if (!first.ok) throw new Error("expected ok");
    expect(first.graph.truncated).toBe(true);
    expect(first.graph.nextCursor).toBeDefined();
    const second = projectAgentGraph(canvas(), { limit: 2, cursor: first.graph.nextCursor });
    if (!second.ok) throw new Error("expected ok");
    const ids = [...first.graph.nodes, ...second.graph.nodes].map((node) => node.nodeId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("翻页期间 revision 变化返回 snapshot-stale", () => {
    const first = projectAgentGraph(canvas(), { limit: 2 });
    if (!first.ok) throw new Error("expected ok");
    const changed = canvas({ revision: 4 });
    const stale = projectAgentGraph(changed, { limit: 2, cursor: first.graph.nextCursor });
    expect(stale).toMatchObject({ ok: false, code: "snapshot-stale", currentRevision: 4 });
  });

  it("cursor 编码可逆", () => {
    const cursor = encodeAgentCursor(7, 3);
    expect(decodeAgentCursor(cursor)).toEqual({ revision: 7, offset: 3 });
    expect(decodeAgentCursor("garbage")).toBeNull();
  });

  it("未知节点返回 unknown-node", () => {
    expect(projectAgentGraph(canvas(), { aroundNodeId: "nope" })).toMatchObject({ ok: false, code: "unknown-node" });
  });
});

describe("Agent 增量（任务 3.4）", () => {
  it("计算出 changed nodes/edges 与 tombstones", () => {
    const before = canvas();
    const after = canvas({
      revision: 4,
      document: {
        schemaVersion: "asset-canvas-v1",
        updatedAt: "2026-09-28T01:00:00.000Z",
        nodes: [
          { id: "a", type: "text", position: { x: 0, y: 0 }, width: 248, height: 232 },
          { id: "b", type: "image", position: { x: 120, y: 0 }, width: 248, height: 232 }
        ],
        edges: []
      },
      nodeData: {
        a: { prompt: "changed", taskKind: "text-generation", taskStatus: "idle" },
        b: { prompt: "draw", taskKind: "image-generation", taskStatus: "processing", progress: 0.5, activeRunId: "r1" }
      }
    });
    const delta = computeAgentDelta(before, after);
    expect(delta.deletedNodeIds).toEqual(["c", "d"]);
    expect(delta.deletedEdgeIds.sort()).toEqual(["e-ab", "e-bc"]);
    expect(delta.nodes.map((node) => node.nodeId)).toContain("a");
    expect(delta.nodes.map((node) => node.nodeId)).toContain("b");
    const built = buildAgentDelta(after, 3, delta);
    expect(built).toMatchObject({ fromRevision: 3, currentRevision: 4, resetRequired: false });
  });
});
