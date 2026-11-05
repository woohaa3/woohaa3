/**
 * 多选聚合拉线纯逻辑单元测试
 * （change: add-multi-select-aggregate-connect，design D1–D6）。
 */
import { describe, expect, it } from "vitest";
import { buildCanvasRenderScene, createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import {
  aggregateConnectProjection,
  aggregatePreviewEdges,
  aggregateTargetAt,
  hitAggregateHandle,
  planAggregateBatchConnect,
  sceneAggregateHandleGeometry,
} from "./aggregate-connect.js";

type NodeSpec = {
  id: string;
  type?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  parentId?: string;
};

function canvas(nodes: NodeSpec[], edges: Array<{ id: string; source: string; target: string }> = [], nodeData: Record<string, unknown> = {}): ServerCanvas {
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
        ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
      })),
      edges: edges.map((edge) => ({ ...edge, sourceHandle: null, targetHandle: null, data: {} })),
    },
    nodeData: nodeData as ServerCanvas["nodeData"],
  };
}

function sceneOf(canvasState: ServerCanvas, selection: string[]) {
  return buildCanvasRenderScene({ canvas: canvasState, selection: { nodes: selection } });
}

describe("选区把手几何（design D1/D2）", () => {
  const canvasState = canvas([
    { id: "a", x: 0, y: 0, width: 200, height: 120 },
    { id: "b", x: 200, y: 100, width: 200, height: 120 },
  ]);

  it("单选普通节点不显示把手", () => {
    expect(sceneAggregateHandleGeometry(sceneOf(canvasState, ["a"]))).toBeNull();
  });

  it("单选 group 不显示把手（已自带聚合端点）", () => {
    const withGroup = canvas([
      { id: "g", type: "group", x: 0, y: 0, width: 300, height: 200 },
      { id: "m", type: "image", parentId: "g", x: 20, y: 20 },
    ]);
    expect(sceneAggregateHandleGeometry(sceneOf(withGroup, ["g"]))).toBeNull();
  });

  it("多选显示左右把手，位置贴选区包围盒", () => {
    const geometry = sceneAggregateHandleGeometry(sceneOf(canvasState, ["a", "b"]))!;
    expect(geometry).not.toBeNull();
    expect(geometry.bounds).toEqual({ x: 0, y: 0, width: 400, height: 220 });
    expect(geometry.input).toEqual({ x: -18, y: 110 });
    expect(geometry.output).toEqual({ x: 418, y: 110 });
  });

  it("命中把手返回方向；远离时不命中", () => {
    const scene = sceneOf(canvasState, ["a", "b"]);
    expect(hitAggregateHandle(scene, { x: 418, y: 110 })).toEqual({ direction: "output" });
    expect(hitAggregateHandle(scene, { x: -18, y: 110 })).toEqual({ direction: "input" });
    expect(hitAggregateHandle(scene, { x: 500, y: 500 })).toBeNull();
  });
});

describe("批量规划与去重（design D3）", () => {
  it("输出把手：每个成员 -> 目标；输入把手：目标 -> 成员", () => {
    const canvasState = canvas([
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 0, y: 200 },
      { id: "t", x: 400, y: 0 },
    ]);
    const out = planAggregateBatchConnect(canvasState, ["a", "b"], "t", "output");
    expect(out.every((c) => c.type === "edge.add")).toBe(true);
    expect(out.map((c) => (c as { edge: { source: string; target: string } }).edge)).toMatchObject([
      { source: "a", target: "t" },
      { source: "b", target: "t" },
    ]);
    const input = planAggregateBatchConnect(canvasState, ["a", "b"], "t", "input");
    expect(input.map((c) => (c as { edge: { source: string; target: string } }).edge)).toMatchObject([
      { source: "t", target: "a" },
      { source: "t", target: "b" },
    ]);
  });

  it("已有同向边被过滤；稳定 edge id", () => {
    const canvasState = canvas(
      [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 0, y: 200 },
        { id: "t", x: 400, y: 0 },
      ],
      [{ id: "e1", source: "a", target: "t" }],
    );
    const out = planAggregateBatchConnect(canvasState, ["a", "b"], "t", "output");
    expect(out).toHaveLength(1);
    expect((out[0] as { edge: { source: string } }).edge.source).toBe("b");
  });

  it("目标为纯备注时无合法边（空批次）", () => {
    const withNote = canvas(
      [
        { id: "a", x: 0, y: 0 },
        { id: "n", type: "text", x: 400, y: 0 },
      ],
      [],
      { n: { isNote: true } },
    );
    expect(planAggregateBatchConnect(withNote, ["a"], "n", "output")).toHaveLength(0);
  });

  it("成员与目标相同被过滤", () => {
    const canvasState = canvas([
      { id: "a", x: 0, y: 0 },
      { id: "b", x: 0, y: 200 },
    ]);
    expect(planAggregateBatchConnect(canvasState, ["a"], "a", "output")).toHaveLength(0);
  });
});

describe("拖拽预览与投影（design D5）", () => {
  const canvasState = canvas([
    { id: "a", x: 0, y: 0, width: 100, height: 50 },
    { id: "b", x: 0, y: 200, width: 100, height: 50 },
    { id: "t", x: 400, y: 0, width: 100, height: 50 },
  ]);

  it("指针落在目标节点上生成预览边；落在成员或空白为空", () => {
    const scene = sceneOf(canvasState, ["a", "b"]);
    expect(aggregatePreviewEdges(canvasState, scene, ["a", "b"], "output", { x: 450, y: 25 })).toHaveLength(2);
    expect(aggregatePreviewEdges(canvasState, scene, ["a", "b"], "output", { x: 50, y: 25 })).toHaveLength(0);
    expect(aggregatePreviewEdges(canvasState, scene, ["a", "b"], "output", { x: 999, y: 999 })).toHaveLength(0);
  });

  it("重叠节点取视觉层级最高者", () => {
    const overlap = canvas([
      { id: "a", x: 0, y: 0, width: 100, height: 50 },
      { id: "t1", x: 400, y: 0, width: 100, height: 50 },
      { id: "t2", x: 400, y: 0, width: 100, height: 50 },
    ]);
    const scene = sceneOf(overlap, ["a"]);
    expect(aggregateTargetAt(scene, ["a"], { x: 450, y: 25 })).toEqual({ id: "t2" });
  });

  it("投影原样携带方向/cursor/pendingEdges", () => {
    const edges = [{ id: "e1", source: "a", target: "t" }];
    expect(aggregateConnectProjection("output", { x: 1, y: 2 }, edges)).toEqual({
      direction: "output",
      cursor: { x: 1, y: 2 },
      pendingEdges: edges,
    });
    expect("cursor" in aggregateConnectProjection(null, null, [])).toBe(false);
  });
});
