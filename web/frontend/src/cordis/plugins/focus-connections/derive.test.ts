/**
 * 聚焦连接圆点派生测试
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 7.1）。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { deriveFocusConnections } from "./derive.js";

const NOW = "2026-10-08T00:00:00.000Z";

function canvas(input: {
  nodes: string[];
  edges: Array<{ id: string; source: string; target: string }>;
  nodeData?: Record<string, unknown>;
  types?: Record<string, string>;
}): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("canvas-1", NOW);
  return {
    ...base,
    document: {
      ...base.document,
      nodes: input.nodes.map((id) => ({ id, type: input.types?.[id] ?? "image", position: { x: 0, y: 0 } })),
      edges: input.edges.map((edge) => ({ ...edge }))
    },
    nodeData: input.nodeData ?? {}
  } as unknown as ServerCanvas;
}

describe("deriveFocusConnections", () => {
  it("区分入/出方向并按节点去重", () => {
    const c = canvas({
      nodes: ["focus", "a", "b"],
      edges: [
        { id: "e1", source: "a", target: "focus" },
        { id: "e2", source: "a", target: "focus" },
        { id: "e3", source: "focus", target: "b" },
        { id: "e4", source: "focus", target: "b" }
      ]
    });
    const result = deriveFocusConnections(c, "focus");
    expect(result.incoming.map((dot) => dot.nodeId)).toEqual(["a"]);
    expect(result.outgoing.map((dot) => dot.nodeId)).toEqual(["b"]);
  });

  it("自环不进入任一侧", () => {
    const c = canvas({ nodes: ["focus"], edges: [{ id: "e1", source: "focus", target: "focus" }] });
    expect(deriveFocusConnections(c, "focus")).toEqual({ incoming: [], outgoing: [] });
  });

  it("远端节点不存在时忽略该边", () => {
    const c = canvas({ nodes: ["focus"], edges: [{ id: "e1", source: "ghost", target: "focus" }] });
    expect(deriveFocusConnections(c, "focus").incoming).toEqual([]);
  });

  it("入边优先使用合法 inputMapping.sortKey 排序", () => {
    const c = canvas({
      nodes: ["focus", "a", "b", "c"],
      edges: [
        { id: "e1", source: "a", target: "focus" },
        { id: "e2", source: "b", target: "focus" },
        { id: "e3", source: "c", target: "focus" }
      ],
      nodeData: {
        focus: { inputMapping: [{ sourceNodeId: "c", role: "x", sortKey: "0" }, { sourceNodeId: "b", role: "x", sortKey: "1" }] }
      }
    });
    // c(sortKey 0) → b(1) → a(无 key，按稳定节点顺序)
    expect(deriveFocusConnections(c, "focus").incoming.map((dot) => dot.nodeId)).toEqual(["c", "b", "a"]);
  });

  it("其余连接按稳定节点顺序再 ID 排序", () => {
    const c = canvas({
      nodes: ["focus", "z", "a", "m"],
      edges: [
        { id: "e1", source: "z", target: "focus" },
        { id: "e2", source: "a", target: "focus" },
        { id: "e3", source: "m", target: "focus" }
      ]
    });
    expect(deriveFocusConnections(c, "focus").incoming.map((dot) => dot.nodeId)).toEqual(["z", "a", "m"]);
  });

  it("节点标题优先用户标题，否则类型回退", () => {
    const c = canvas({
      nodes: ["focus", "a", "b"],
      edges: [
        { id: "e1", source: "a", target: "focus" },
        { id: "e2", source: "focus", target: "b" }
      ],
      nodeData: { a: { title: "自定义" } },
      types: { b: "video" }
    });
    const result = deriveFocusConnections(c, "focus");
    expect(result.incoming[0].nodeTitle).toBe("自定义");
    expect(result.outgoing[0].nodeTitle).toBe("视频节点");
  });

  it("null 画布返回空", () => {
    expect(deriveFocusConnections(null, "focus")).toEqual({ incoming: [], outgoing: [] });
  });
});
