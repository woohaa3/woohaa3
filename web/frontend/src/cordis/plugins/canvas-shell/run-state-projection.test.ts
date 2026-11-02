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
  it("explicit film feedback controls decoration even when compatibility busy remains true", () => {
    const nodes = [node("film", { type: "model", busy: true, compositeAsset: { x: 0, y: 0, width: 100, height: 100 } })];
    applyRunStateProjection(nodes, { summaries: [summary("film", { isAggregate: true, aggregateRunning: true,
      filmSetFeedback: { operationKey: "attempt", phase: "running", source: "conversion", labelCode: "generating" } })], records: [] });
    expect(nodes[0].aggregateRun).toMatchObject({ active: true, filmSet: { phase: "running" } });
    // failed 是静态终态：保留失败摘要，但不再显示运行中遮罩。
    applyRunStateProjection(nodes, { summaries: [summary("film", { isAggregate: true, aggregateRunning: true,
      filmSetFeedback: { operationKey: "attempt", phase: "failed", source: "conversion", labelCode: "failed" } })], records: [] });
    expect(nodes[0].aggregateRun).toMatchObject({ active: false, filmSet: { phase: "failed" } });
    applyRunStateProjection(nodes, { summaries: [summary("film", { isAggregate: true, aggregateRunning: true, filmSetFeedback: null })], records: [] });
    expect(nodes[0].aggregateRun?.active).toBe(false);
    expect(nodes[0].busy).toBe(true);
  });
  it("规范节点 busy 的内容交付复用聚合执行遮罩，不依赖 Agent 操作记录", () => {
    const nodes = [node("film", { type: "model", busy: true, compositeAsset: { x: 0, y: 0, width: 100, height: 100 } })];
    applyRunStateProjection(nodes, { summaries: [], records: [] });
    expect(nodes[0].aggregateRun).toEqual({ active: true });
    expect(nodes[0].historyStrip).toBeUndefined();
    nodes[0].busy = false;
    applyRunStateProjection(nodes, { summaries: [summary("film", { isAggregate: true })], records: [] });
    expect(nodes[0].aggregateRun).toEqual({ active: false });
  });
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

  it("组节点只投影运行标识，不携带 ledger 身份；记录清空后移除标识", () => {
    const nodes = [node("g", { type: "group", group: { title: "组", memberCount: 0, outputCapableLeafCount: 0 } })];
    applyRunStateProjection(nodes, { summaries: [], records: [], groupStatuses: new Map([["g", { state: "running", label: "创作中" }]]) });
    expect(nodes[0].group?.runStatus).toEqual({ state: "running", label: "创作中" });
    expect(nodes[0].historyStrip).toBeUndefined();
    applyRunStateProjection(nodes, { summaries: [], records: [] });
    expect(nodes[0].group?.runStatus).toBeUndefined();
  });
  it("片场 group 的执行反馈驱动与普通组相同的气泡运行态", () => {
    const nodes = [node("film", { type: "group", group: { title: "片场", memberCount: 2, outputCapableLeafCount: 0 } })];
    const phases = [
      ["submitting", "preparing", "提交中"],
      ["queued", "queued", "排队中"],
      ["running", "running", "生成中"],
      ["committing", "committing", "保存中"],
      ["failed", "failed", "失败"]
    ] as const;
    for (const [phase, state, label] of phases) {
      applyRunStateProjection(nodes, {
        summaries: [summary("film", { isAggregate: true, filmSetFeedback: {
          operationKey: "attempt", phase, source: "conversion", labelCode: phase === "committing" ? "saving" : phase === "running" ? "generating" : phase
        } })],
        records: []
      });
      // 片场迁移为 group 后 MUST 走 group 通路；`aggregateRun.filmSet` 会被 renderer 拒绝。
      expect(nodes[0].group?.runStatus).toEqual({ state, label });
      expect(nodes[0].aggregateRun).toBeUndefined();
      expect(nodes[0].historyStrip).toBeUndefined();
    }
    applyRunStateProjection(nodes, { summaries: [summary("film", { isAggregate: true, filmSetFeedback: null })], records: [] });
    expect(nodes[0].group?.runStatus).toBeUndefined();
  });
  it("显式组执行状态优先于片场反馈", () => {
    const nodes = [node("film", { type: "group", group: { title: "片场", memberCount: 1, outputCapableLeafCount: 0 } })];
    applyRunStateProjection(nodes, {
      summaries: [summary("film", { isAggregate: true, filmSetFeedback: {
        operationKey: "attempt", phase: "running", source: "conversion", labelCode: "generating"
      } })],
      records: [],
      groupStatuses: new Map([["film", { state: "queued", label: "等待助手" }]])
    });
    expect(nodes[0].group?.runStatus).toEqual({ state: "queued", label: "等待助手" });
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
      { state: "succeeded", current: true, recoverable: false },
      { state: "running", current: false }
    ]);
    expect(nodes[0]?.historyStrip?.truncated).toBe(0);
  });

  it("当前操作映射优先于滞后的历史 current，黄点转绿后外圈立即移动", () => {
    const nodes = [node("n1")];
    const history = [
      { entryId: "old", nodeId: "n1", nodeTitle: "test", kind: "image", createdAt: "2026-10-12T00:00:01.000Z", current: true,
        recoverable: true, outcome: "succeeded", previewable: true, source: { runId: "old", label: "old" }, preview: { kind: "text", excerpt: "old" } },
      { entryId: "run", nodeId: "n1", nodeTitle: "test", kind: "image", createdAt: "2026-10-12T00:00:02.000Z", current: false,
        recoverable: true, outcome: "succeeded", previewable: true, source: { runId: "run", label: "run" }, preview: { kind: "text", excerpt: "run" } }
    ] as never;
    applyRunStateProjection(nodes, {
      summaries: [summary("n1")],
      records: [op("run", "succeeded", "2026-10-12T00:00:02.000Z")],
      versionsByNode: new Map([["n1", history]]),
      currentOperationByNode: new Map([["n1", "run"]])
    });
    expect(nodes[0]?.historyStrip?.dots).toMatchObject([
      { state: "succeeded", current: false },
      { state: "succeeded", current: true }
    ]);
  });

  it("未查看的历史条目投影为圆点角标，不改变状态颜色或当前装饰", () => {
    const nodes = [node("n1")];
    const history = [{ entryId: "a", nodeId: "n1", nodeTitle: "test", kind: "image", createdAt: "2026-10-12T00:00:01.000Z", current: false,
      recoverable: true, outcome: "succeeded", previewable: true, source: { label: "a" }, preview: { kind: "text", excerpt: "a" } },
    { entryId: "b", nodeId: "n1", nodeTitle: "test", kind: "image", createdAt: "2026-10-12T00:00:02.000Z", current: true,
      recoverable: true, outcome: "succeeded", previewable: true, source: { label: "b" }, preview: { kind: "text", excerpt: "b" } }] as never;
    applyRunStateProjection(nodes, {
      summaries: [summary("n1")],
      records: [],
      versionsByNode: new Map([["n1", history]]),
      unseenByNode: new Map([["n1", new Set(["a"])]])
    });
    expect(nodes[0]?.historyStrip?.dots[0]).toMatchObject({ state: "succeeded", current: false, unseen: true });
  });
  it("单个新完成版本带未读时仍显示圆点", () => {
    const nodes = [node("n1")];
    const history = [{ entryId: "a", nodeId: "n1", nodeTitle: "test", kind: "image", createdAt: "2026-10-12T00:00:01.000Z", current: true,
      recoverable: true, outcome: "succeeded", previewable: true, source: { label: "a" }, preview: { kind: "text", excerpt: "a" } }] as never;
    applyRunStateProjection(nodes, {
      summaries: [summary("n1")],
      records: [],
      versionsByNode: new Map([["n1", history]]),
      unseenByNode: new Map([["n1", new Set(["a"])]])
    });
    expect(nodes[0]?.historyStrip?.dots[0]).toMatchObject({ state: "succeeded", current: true, unseen: true });
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

  it("聚合节点只写运行遮罩，不写历史条", () => {
    const nodes = [node("film", { type: "model", compositeAsset: { x: 0, y: 0, width: 100, height: 100 } })];
    applyRunStateProjection(nodes, {
      summaries: [summary("film", { isAggregate: true, aggregateRunning: true, active: op("r", "running", "2026-10-12T00:00:00.000Z", "film") })],
      records: [op("r", "running", "2026-10-12T00:00:00.000Z", "film")]
    });
    expect(nodes[0]?.aggregateRun).toEqual({ active: true });
    expect(nodes[0]?.historyStrip).toBeUndefined();
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

  it("group 节点不写历史条", () => {
    const nodes = [node("g", { type: "group", group: { title: "", memberCount: 1, outputCapableLeafCount: 1 } })];
    applyRunStateProjection(nodes, {
      summaries: [summary("g")],
      records: [op("a", "succeeded", "2026-10-12T00:00:00.000Z", "g")]
    });
    expect(nodes[0]?.historyStrip).toBeUndefined();
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
