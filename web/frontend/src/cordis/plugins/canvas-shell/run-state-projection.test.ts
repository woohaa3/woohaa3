/**
 * 运行状态 → 历史条/聚合遮罩投影测试
 * （change: 2026-10-12-unify-generation-history-strip，design D4/D5）。
 */
import { describe, expect, it } from "vitest";
import type { BevyRenderNode, CanvasNodeRunSummary, CanvasOperationRecord, CanvasRenderScene } from "@woohaa3/contracts";
import { applyRunStateProjection } from "./run-state-projection.js";

function node(id: string, extra: Partial<BevyRenderNode> = {}): BevyRenderNode {
  return {
    id,
    type: "image",
    x: 0,
    y: 0,
    width: 248,
    height: 232,
    body: "",
    title: "",
    typeLabel: "",
    progress: 0,
    busy: false,
    texture: false,
    resizable: false,
    ...extra
  };
}

/** 运行状态投影现在写入场景级 `runFeedback`；测试用最小场景承载同一批节点。 */
function scene(nodes: BevyRenderNode[]): CanvasRenderScene {
  return { version: "woohaa-canvas-render-scene-v31", revision: 0, nodes, edges: [],
    selection: { nodes: [], edge: null }, viewport: { x: 0, y: 0, zoom: 1 }, draft: null, surface: null } as unknown as CanvasRenderScene;
}

function op(operationId: string, state: CanvasOperationRecord["state"], createdAt: string, nodeId = "n1"): CanvasOperationRecord {
  return {
    operationId,
    canvasId: "c",
    nodeId,
    kind: "image",
    state,
    owner: "server",
    createdAt,
    updatedAt: createdAt
  };
}

function summary(nodeId: string, extra: Partial<CanvasNodeRunSummary> = {}): CanvasNodeRunSummary {
  return { canvasId: "c", nodeId, active: null, isAggregate: false, aggregateRunning: false, ...extra };
}

describe("applyRunStateProjection", () => {
  it("explicit film feedback controls decoration even when compatibility busy remains true", () => {
    const nodes = [node("film", { type: "model", busy: true, compositeAsset: { x: 0, y: 0, width: 100, height: 100 } })];
    const renderScene = scene(nodes);
    applyRunStateProjection(renderScene, { summaries: [summary("film", { isAggregate: true, aggregateRunning: true,
      filmSetFeedback: { operationKey: "attempt", phase: "running", source: "conversion", labelCode: "generating" } })], records: [] });
    expect(nodes[0].aggregateRun).toEqual({ active: true });
    expect(renderScene.runFeedback).toMatchObject([{ nodeId: "film", phase: "running", labelCode: "generating", active: true }]);
    // failed 是静态终态：保留失败摘要，但不再显示运行中遮罩。
    applyRunStateProjection(renderScene, { summaries: [summary("film", { isAggregate: true, aggregateRunning: true,
      filmSetFeedback: { operationKey: "attempt", phase: "failed", source: "conversion", labelCode: "failed" } })], records: [] });
    expect(nodes[0].aggregateRun).toEqual({ active: false });
    expect(renderScene.runFeedback).toMatchObject([{ nodeId: "film", phase: "failed", active: false }]);
    applyRunStateProjection(renderScene, { summaries: [summary("film", { isAggregate: true, aggregateRunning: true, filmSetFeedback: null })], records: [] });
    expect(nodes[0].aggregateRun?.active).toBe(false);
    expect(renderScene.runFeedback).toBeUndefined();
    expect(nodes[0].busy).toBe(true);
  });
  it("规范节点 busy 的内容交付复用聚合执行遮罩，不依赖 Agent 操作记录", () => {
    const nodes = [node("film", { type: "model", busy: true, compositeAsset: { x: 0, y: 0, width: 100, height: 100 } })];
    applyRunStateProjection(scene(nodes), { summaries: [], records: [] });
    expect(nodes[0].aggregateRun).toEqual({ active: true });
    expect(nodes[0].historyStrip).toBeUndefined();
    nodes[0].busy = false;
    applyRunStateProjection(scene(nodes), { summaries: [summary("film", { isAggregate: true })], records: [] });
    expect(nodes[0].aggregateRun).toEqual({ active: false });
  });
  it("组节点只投影运行标识，不携带 ledger 身份；记录清空后移除标识", () => {
    const nodes = [node("g", { type: "group", group: { title: "组", memberCount: 0, outputCapableLeafCount: 0 } })];
    applyRunStateProjection(scene(nodes), { summaries: [], records: [], groupStatuses: new Map([["g", { state: "running", label: "创作中" }]]) });
    expect(nodes[0].group?.runStatus).toEqual({ state: "running", label: "创作中" });
    expect(nodes[0].historyStrip).toBeUndefined();
    applyRunStateProjection(scene(nodes), { summaries: [], records: [] });
    expect(nodes[0].group?.runStatus).toBeUndefined();
  });
  it("普通节点投影有界圆点，当前版本用装饰且不挤占状态颜色", () => {
    const nodes = [node("n1")];
    applyRunStateProjection(scene(nodes), {
      summaries: [summary("n1", { active: op("b", "running", "2026-10-12T00:00:02.000Z") })],
      records: [
        op("a", "succeeded", "2026-10-12T00:00:01.000Z"),
        op("b", "running", "2026-10-12T00:00:02.000Z")
      ],
      currentOperationByNode: new Map([["n1", "a"]])
    });
    expect(nodes[0]?.historyStrip?.dots).toMatchObject([
      { state: "succeeded", current: false, recoverable: false },
      { state: "running", current: false }
    ]);
    expect(nodes[0]?.historyStrip?.truncated).toBe(0);
  });

  it("历史过多折叠较早记录", () => {
    const records = Array.from({ length: 30 }, (_, index) =>
      op(`o${index}`, "succeeded", `2026-10-12T00:00:${String(index).padStart(2, "0")}.000Z`)
    );
    const nodes = [node("n1")];
    applyRunStateProjection(scene(nodes), { summaries: [summary("n1")], records });
    expect(nodes[0]?.historyStrip?.dots).toHaveLength(24);
    expect(nodes[0]?.historyStrip?.truncated).toBe(6);
  });

  it("聚合节点只写运行遮罩，不写历史条", () => {
    const nodes = [node("film", { type: "model", compositeAsset: { x: 0, y: 0, width: 100, height: 100 } })];
    applyRunStateProjection(scene(nodes), {
      summaries: [summary("film", { isAggregate: true, aggregateRunning: true, active: op("r", "running", "2026-10-12T00:00:00.000Z", "film") })],
      records: [op("r", "running", "2026-10-12T00:00:00.000Z", "film")]
    });
    expect(nodes[0]?.aggregateRun).toEqual({ active: true });
    expect(nodes[0]?.historyStrip).toBeUndefined();
  });

  it("有运行中操作即点亮 busy，与图片/视频节点的执行中呈现一致", () => {
    const nodes = [node("n1", { type: "model" })];
    applyRunStateProjection(scene(nodes), {
      summaries: [summary("n1", { active: op("agent:req-1", "running", "2026-10-12T00:00:00.000Z") })],
      records: [op("agent:req-1", "running", "2026-10-12T00:00:00.000Z")]
    });
    expect(nodes[0]?.busy).toBe(true);
  });

  it("无运行中操作时不点亮 busy", () => {
    const nodes = [node("n1", { type: "model" })];
    applyRunStateProjection(scene(nodes), {
      summaries: [summary("n1")],
      records: [op("a", "succeeded", "2026-10-12T00:00:00.000Z")]
    });
    expect(nodes[0]?.busy).toBe(false);
  });

  it("group 节点不写历史条", () => {
    const nodes = [node("g", { type: "group", group: { title: "", memberCount: 1, outputCapableLeafCount: 1 } })];
    applyRunStateProjection(scene(nodes), {
      summaries: [summary("g")],
      records: [op("a", "succeeded", "2026-10-12T00:00:00.000Z", "g")]
    });
    expect(nodes[0]?.historyStrip).toBeUndefined();
  });

  it("失败/取消圆点状态映射且无当前装饰", () => {
    const nodes = [node("n1")];
    applyRunStateProjection(scene(nodes), {
      summaries: [summary("n1")],
      records: [
        op("f", "failed", "2026-10-12T00:00:01.000Z"),
        op("c", "cancelled", "2026-10-12T00:00:02.000Z")
      ]
    });
    expect(nodes[0]?.historyStrip?.dots.map((dot) => dot.state)).toEqual(["failed", "cancelled"]);
    expect(nodes[0]?.historyStrip?.dots.every((dot) => !dot.current)).toBe(true);
  });
});
