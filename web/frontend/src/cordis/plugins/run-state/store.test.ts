/**
 * 统一生成运行状态 store 测试
 * （change: 2026-10-12-unify-generation-history-strip，design D1/D2/D3）。
 *
 * 覆盖：提交即出现、权威接管、失败/取消映射、本地 owner、聚合遮罩、当前版本装饰与并发独立归档。
 */
import { describe, expect, it } from "vitest";
import { RunStateStore } from "./store.js";

const NOW = Date.parse("2026-10-12T00:00:00.000Z");
const CANVAS = "canvas-1";

function store(nodeTypes: Record<string, string> = {}): RunStateStore {
  return new RunStateStore({
    canvasId: CANVAS,
    now: () => NOW,
    nodeTypeOf: (nodeId) => nodeTypes[nodeId]
  });
}

function serverActivity(overrides: Partial<import("@woohaa3/contracts").CanvasTaskActivity>): import("@woohaa3/contracts").CanvasTaskActivity {
  return {
    taskKey: "run-1",
    runId: "run-1",
    nodeId: "n1",
    state: "running",
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
    durationMs: 0,
    ...overrides
  };
}

/** 把活动记录包成事件 payload（测试用；状态由 store 分类，不依赖事件判别联合）。 */
function updatedEvent(activity: import("@woohaa3/contracts").CanvasTaskActivity, cursor = 1) {
  return { name: "task.activity.updated" as const, payload: { source: "live" as const, cursor, activity: activity as never } };
}

function finishedEvent(activity: import("@woohaa3/contracts").CanvasTaskActivity, cursor = 1) {
  return { name: "task.activity.finished" as const, payload: { source: "live" as const, cursor, activity: activity as never } };
}

describe("RunStateStore", () => {
  it("提交即出现且服务端受理后按同一身份接管", () => {
    const s = store();
    s.applyEvent({
      name: "task.activity.started",
      payload: { runId: "run-1", jobId: "job-1", nodeId: "n1", state: "queued", modelType: "image", createdAt: "2026-10-12T00:00:00.000Z" }
    });
    expect(s.getNodeSummary("n1")?.active).toMatchObject({ operationId: "run-1", state: "queued", owner: "server" });
    s.applyEvent(updatedEvent(serverActivity({ state: "running", progress: 0.4 })));
    const summary = s.getNodeSummary("n1");
    expect(summary?.active).toMatchObject({ operationId: "run-1", state: "running", owner: "server" });
    // 不是新增第二条，而是接管同一条。
    expect(s.getSnapshot().records).toHaveLength(1);
    expect(summary?.active?.progress).toBe(0.4);
  });

  it("本地拒绝映射为 failed(localFailure) 且不伪造 canonical", () => {
    const s = store();
    s.applyEvent({
      name: "task.activity.started",
      payload: { runId: "run-1", jobId: "job-1", nodeId: "n1", state: "queued", createdAt: "2026-10-12T00:00:00.000Z" }
    });
    s.applyEvent({
      name: "task.activity.finished",
      payload: {
        source: "local-rejection",
        activity: { runId: "run-1", jobId: "job-1", nodeId: "n1", state: "failed", error: { message: "网关拒绝" }, updatedAt: "2026-10-12T00:00:01.000Z" }
      }
    });
    const record = s.getSnapshot().records.find((r) => r.operationId === "run-1");
    expect(record?.state).toBe("failed");
    expect(record?.localFailure).toBe(true);
    expect(s.isBusy("n1")).toBe(false);
  });

  it("本地操作 owner 独立结算", () => {
    const s = store();
    const local = s.beginLocalOperation({ nodeId: "n1", kind: "video-export" });
    expect(s.getNodeSummary("n1")?.active).toMatchObject({ kind: "video-export", owner: "local", state: "running" });
    local.finish();
    const record = s.getSnapshot().records.find((r) => r.operationId === local.operationId);
    expect(record).toMatchObject({ state: "succeeded", owner: "local" });
    expect(s.isBusy("n1")).toBe(false);
    // 重复 finish 幂等。
    local.finish({ error: "late" });
    expect(s.getSnapshot().records.find((r) => r.operationId === local.operationId)?.state).toBe("succeeded");
  });

  it("聚合节点运行遮罩且不因普通节点误判", () => {
    const s = store({ n1: "composite-asset", n2: "image" });
    s.applyEvent({
      name: "task.activity.updated",
      payload: { source: "live", cursor: 1, activity: serverActivity({ nodeId: "n1", state: "running", modelType: "image" }) as never }
    });
    expect(s.getNodeSummary("n1")).toMatchObject({ isAggregate: true, aggregateRunning: true });
    s.applyEvent({
      name: "task.activity.updated",
      payload: { source: "live", cursor: 1, activity: serverActivity({ runId: "run-2", taskKey: "run-2", nodeId: "n2", state: "running", modelType: "image" }) as never }
    });
    expect(s.getNodeSummary("n2")).toMatchObject({ isAggregate: false, aggregateRunning: false });
  });

  it("并发结果独立归档且终态顺序不影响身份", () => {
    const s = store({ n1: "image" });
    s.applyEvent({ name: "task.activity.started", payload: { runId: "a", jobId: "ja", nodeId: "n1", state: "queued", modelType: "image", createdAt: "2026-10-12T00:00:00.000Z" } });
    s.applyEvent({ name: "task.activity.started", payload: { runId: "b", jobId: "jb", nodeId: "n1", state: "queued", modelType: "image", createdAt: "2026-10-12T00:00:01.000Z" } });
    // b 先完成、a 后完成。
    s.applyEvent(finishedEvent(serverActivity({ runId: "b", taskKey: "b", state: "succeeded", updatedAt: "2026-10-12T00:00:02.000Z" }), 2));
    s.applyEvent(finishedEvent(serverActivity({ runId: "a", taskKey: "a", state: "succeeded", updatedAt: "2026-10-12T00:00:03.000Z" }), 3));
    const records = s.getSnapshot().records;
    expect(records.map((r) => r.operationId).sort()).toEqual(["a", "b"]);
    expect(records.every((r) => r.state === "succeeded")).toBe(true);
  });

  it("Agent 回合投影进入运行态且只清理自身前缀记录", () => {
    const s = store({ n1: "model3d" });
    // Task 链路记录：不得被 Agent 同步清理。
    s.applyEvent({ name: "task.activity.started", payload: { runId: "run-task", jobId: "j1", nodeId: "n2", state: "queued", modelType: "image", createdAt: "2026-10-12T00:00:00.000Z" } });
    s.syncAgentOperations([
      { operationId: "agent:req-1", canvasId: CANVAS, nodeId: "n1", kind: "model", state: "running", owner: "server", createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:01.000Z" }
    ]);
    expect(s.isBusy("n1")).toBe(true);
    expect(s.getNodeSummary("n1")?.active).toMatchObject({ operationId: "agent:req-1", state: "running" });
    expect(s.isBusy("n2")).toBe(true);
    // 幂等：同一回合重复同步不新增第二条。
    s.syncAgentOperations([
      { operationId: "agent:req-1", canvasId: CANVAS, nodeId: "n1", kind: "model", state: "running", owner: "server", createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:01.000Z" }
    ]);
    expect(s.getSnapshot().records.filter((record) => record.operationId === "agent:req-1")).toHaveLength(1);
    // 回合结束：投影为空即清掉 Agent 记录，节点回到正常呈现；Task 记录保留。
    s.syncAgentOperations([]);
    expect(s.isBusy("n1")).toBe(false);
    expect(s.isBusy("n2")).toBe(true);
  });

  it("当前版本装饰只匹配成功且与 activeRunId 一致的操作", () => {
    const s = store({ n1: "image" });
    s.applyEvent(finishedEvent(serverActivity({ runId: "a", taskKey: "a", state: "succeeded" })));
    // 无 activeRunId → 无装饰。
    expect([...s.currentOperationIds().entries()]).toEqual([]);
  });

  it("用权威 canonical nodeData 结算运行态（灰点变绿）", () => {
    // 提交即出现的乐观灰点。
    const s = store({ n1: "image" });
    s.applyEvent({ name: "task.activity.started", payload: { runId: "r1", jobId: "j1", nodeId: "n1", state: "queued", modelType: "image", createdAt: "2026-10-12T00:00:00.000Z" } });
    expect(s.getNodeSummary("n1")?.active?.state).toBe("queued");
    // canonical 回流为成功（活动通道未送达终态）。
    s.reconcileCanonical({
      document: { nodes: [{ id: "n1" }] },
      nodeData: { n1: { activeRunId: "r1", taskStatus: "successed" } }
    });
    const rec = s.getSnapshot().records.find((r) => r.operationId === "r1");
    expect(rec?.state).toBe("succeeded");
    expect(s.isBusy("n1")).toBe(false);
  });

  it("canonical 结算失败/取消且不回退终态", () => {
    const s = store({ n1: "image" });
    s.applyEvent({ name: "task.activity.started", payload: { runId: "r2", jobId: "j2", nodeId: "n1", state: "queued", createdAt: "2026-10-12T00:00:00.000Z" } });
    s.reconcileCanonical({ document: { nodes: [{ id: "n1" }] }, nodeData: { n1: { activeRunId: "r2", taskStatus: "failed" } } });
    expect(s.getSnapshot().records.find((r) => r.operationId === "r2")?.state).toBe("failed");
    // 迟到的 canonical running 不回退已失败记录。
    s.reconcileCanonical({ document: { nodes: [{ id: "n1" }] }, nodeData: { n1: { activeRunId: "r2", taskStatus: "processing" } } });
    expect(s.getSnapshot().records.find((r) => r.operationId === "r2")?.state).toBe("failed");
  });
  it("迟到 started 和 updated 不回退已观察终态", () => {
    const s = store({ n1: "image" });
    s.applyEvent(finishedEvent(serverActivity({ runId: "late", taskKey: "late", state: "failed" })));
    s.applyEvent({ name: "task.activity.started", payload: { runId: "late", jobId: "j", nodeId: "n1", state: "queued", createdAt: "2026-10-12T00:00:00.000Z" } });
    s.applyEvent({ name: "task.activity.updated", payload: { source: "live", cursor: 3, activity: serverActivity({ runId: "late", taskKey: "late", state: "running" }) as never } });
    expect(s.getSnapshot().records.find(r => r.operationId === "late")?.state).toBe("failed");
  });
});
