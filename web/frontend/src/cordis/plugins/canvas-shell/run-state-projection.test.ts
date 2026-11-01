/**
 * 运行状态 → 历史条/聚合遮罩投影测试
 * （change: 2026-10-12-unify-generation-history-strip，design D4/D5）。
 */
import { describe, expect, it } from "vitest";
import type { BevyRenderNode, CanvasNodeRunSummary, CanvasOperationRecord } from "@woohaa3/contracts";
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
  it("运行中的节点携带与活动记录同一个进度起点", () => {
    const startedAt = "2026-10-31T00:00:00.000Z";
    const nodes = [node("n1")];
    applyRunStateProjection(nodes, {
      summaries: [summary("n1", { active: op("r1", "running", startedAt) })],
      records: [op("r1", "running", startedAt)]
    });
    expect(nodes[0].busy).toBe(true);
    // 与活动面板同一条记录、同一个 createdAt：两端估算经过时间的起点一致
    // （change: 2026-10-31-unify-node-and-activity-progress）。
    expect(nodes[0].progressStartedAt).toBe(Date.parse(startedAt));
  });

  it("节点结束运行或记录清空后不再携带进度起点", () => {
    const startedAt = "2026-10-31T00:00:00.000Z";
    const running = [node("n1")];
    applyRunStateProjection(running, {
      summaries: [summary("n1", { active: op("r1", "running", startedAt) })],
      records: [op("r1", "running", startedAt)]
    });
    expect(running[0].progressStartedAt).toBeDefined();
    // 场景每帧重建节点，因此用同一份输入重投影后的新节点验证。
    const idle = [node("n1")];
    applyRunStateProjection(idle, { summaries: [], records: [] });
    expect(idle[0].busy).toBe(false);
    expect(idle[0].progressStartedAt).toBeUndefined();
  });

  it("普通节点投影有界圆点，当前版本用装饰且不挤占状态颜色", () => {
    const nodes = [node("n1")];
    applyRunStateProjection(nodes, {
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
    applyRunStateProjection(nodes, { summaries: [summary("n1")], records });
    expect(nodes[0]?.historyStrip?.dots).toHaveLength(24);
    expect(nodes[0]?.historyStrip?.truncated).toBe(6);
  });

  it("有运行中操作即点亮 busy，与图片/视频节点的执行中呈现一致", () => {
    const nodes = [node("n1", { type: "model" })];
    applyRunStateProjection(nodes, {
      summaries: [summary("n1", { active: op("agent:req-1", "running", "2026-10-12T00:00:00.000Z") })],
      records: [op("agent:req-1", "running", "2026-10-12T00:00:00.000Z")]
    });
    expect(nodes[0]?.busy).toBe(true);
  });

  it("无运行中操作时不点亮 busy", () => {
    const nodes = [node("n1", { type: "model" })];
    applyRunStateProjection(nodes, {
      summaries: [summary("n1")],
      records: [op("a", "succeeded", "2026-10-12T00:00:00.000Z")]
    });
    expect(nodes[0]?.busy).toBe(false);
  });

  it("失败/取消圆点状态映射且无当前装饰", () => {
    const nodes = [node("n1")];
    applyRunStateProjection(nodes, {
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
