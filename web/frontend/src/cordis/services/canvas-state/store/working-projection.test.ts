/**
 * Working projection store（change: add-frontend-speculative-canvas-state，任务 2.x）。
 *
 * 覆盖本地原子验证、增量重放、结算、blocked 传播、连续依赖批次与 canonical-only 分离。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, applyCanvasCommands, type CanvasCommand, type ServerCanvas } from "@woohaa3/contracts";
import { WorkingProjectionStore } from "./working-projection.js";

const NOW = "2026-09-26T00:00:00.000Z";

function baseCanvas(): ServerCanvas {
  return createEmptyWoohaa3ServerCanvas("c1", NOW);
}

/** 把命令应用到 canonical 并返回新 canonical（模拟服务端回流）。 */
function advance(canvas: ServerCanvas, commands: readonly CanvasCommand[], revision: number): ServerCanvas {
  const applied = applyCanvasCommands(canvas, commands, { now: NOW });
  if (!applied.ok) throw new Error(applied.rejection.message);
  return { ...applied.canvas, revision };
}

let store: WorkingProjectionStore;

beforeEach(() => {
  store = new WorkingProjectionStore();
});

describe("pending append 与 working 计算", () => {
  it("创建节点立即出现在 workingCanvas 而不推进 canonical revision", () => {
    const canonical = baseCanvas();
    store.applyCanonical(canonical);
    const result = store.appendBatch({
      commandId: "cmd-1",
      baseRevision: 0,
      submittedAt: NOW,
      commands: [{ type: "node.add", node: { id: "a", type: "text", position: { x: 10, y: 20 } } }]
    });
    expect(result.ok).toBe(true);
    expect(store.workingCanvas?.document.nodes.map((n) => n.id)).toEqual(["a"]);
    // canonical 不变、revision 不推进。
    expect(store.canonicalCanvas?.document.nodes).toEqual([]);
    expect(store.workingCanvas?.revision).toBe(0);
  });

  it("本地 reducer 拒绝时不登记 pending", () => {
    store.applyCanonical(baseCanvas());
    const result = store.appendBatch({
      commandId: "cmd-bad",
      baseRevision: 0,
      submittedAt: NOW,
      commands: [{ type: "node.update", nodeId: "ghost", position: { x: 1, y: 1 } }]
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unknown-node");
    expect(store.pendingBatches).toHaveLength(0);
    expect(store.lastRejections).toHaveLength(1);
  });

  it("连续 pending 依赖：第二个批次引用第一个创建节点", () => {
    store.applyCanonical(baseCanvas());
    store.appendBatch({
      commandId: "cmd-1",
      baseRevision: 0,
      submittedAt: NOW,
      commands: [{ type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } }]
    });
    const second = store.appendBatch({
      commandId: "cmd-2",
      baseRevision: 0,
      submittedAt: NOW,
      commands: [{ type: "nodeData.patch", nodeId: "a", value: { prompt: "hi" } }]
    });
    expect(second.ok).toBe(true);
    expect(store.workingCanvas?.nodeData.a).toMatchObject({ prompt: "hi" });
  });
});

describe("canonical update 后重基", () => {
  it("追加已被 canonical 满足的命令不覆盖较早的 pending 位置", () => {
    const canonical = advance(baseCanvas(), [
      { type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } }
    ], 1);
    store.applyCanonical(canonical);
    store.appendBatch({ commandId: "move", baseRevision: 1, submittedAt: NOW,
      commands: [{ type: "node.update", nodeId: "a", position: { x: 50, y: 50 } }] });
    const result = store.appendBatch({ commandId: "already-canonical", baseRevision: 1, submittedAt: NOW,
      commands: [{ type: "node.update", nodeId: "a", position: { x: 0, y: 0 } }] });
    expect(result.ok && result.batch.state).toBe("observed");
    expect(store.pendingBatches.map(batch => batch.commandId)).toEqual(["move"]);
    expect(store.workingCanvas?.document.nodes[0].position).toEqual({ x: 50, y: 50 });
    const incremental = store.snapshot();
    store.applyCanonical(canonical);
    expect(store.snapshot()).toEqual(incremental);
  });

  it("被阻塞前缀之后追加无关批次仍遵守重放阻塞，拒绝前缀后恢复", () => {
    const canonical = advance(baseCanvas(), [
      { type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } }
    ], 1);
    store.applyCanonical(canonical);
    store.appendBatch({ commandId: "move-deleted", baseRevision: 1, submittedAt: NOW,
      commands: [{ type: "node.update", nodeId: "a", position: { x: 50, y: 50 } }] });
    const deleted = advance(canonical, [{ type: "node.remove", nodeIds: ["a"] }], 2);
    store.applyCanonical(deleted);
    store.appendBatch({ commandId: "add-independent", baseRevision: 2, submittedAt: NOW,
      commands: [{ type: "node.add", node: { id: "b", type: "text", position: { x: 20, y: 20 } } }] });
    expect(store.workingCanvas?.document.nodes).toEqual([]);
    expect(store.pendingBatches.map(batch => batch.commandId)).toEqual(["move-deleted", "add-independent"]);
    store.rejectBatch("move-deleted", "deleted remotely");
    expect(store.workingCanvas?.document.nodes.map(node => node.id)).toEqual(["b"]);
    expect(store.canonicalCanvas).toBe(deleted);
  });

  it("accepted 且 canonical 覆盖后移除 pending effect", () => {
    store.applyCanonical(baseCanvas());
    store.appendBatch({
      commandId: "cmd-1",
      baseRevision: 0,
      submittedAt: NOW,
      commands: [{ type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } }]
    });
    store.applyResult({ commandId: "cmd-1", status: "accepted", revision: 1 });
    // canonical 尚未覆盖：批次保留，working 仍显示。
    expect(store.pendingBatches).toHaveLength(1);
    expect(store.workingCanvas?.document.nodes.map((n) => n.id)).toEqual(["a"]);

    // canonical 回流到 revision 1。
    store.applyCanonical(advance(baseCanvas(), [
      { type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } }
    ], 1));
    expect(store.pendingBatches).toHaveLength(0);
    expect(store.workingCanvas?.document.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(store.workingCanvas?.revision).toBe(1);
  });

  it("update-first：effect satisfaction 标记 observed，不重复应用", () => {
    store.applyCanonical(baseCanvas());
    store.appendBatch({
      commandId: "cmd-1",
      baseRevision: 0,
      submittedAt: NOW,
      commands: [{ type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } }]
    });
    // Yjs update 先到，canonical 已含 a，但 result 未到。
    store.applyCanonical(advance(baseCanvas(), [
      { type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } }
    ], 1));
    // 效果已满足 → 批次不应重复应用出重复节点。
    expect(store.workingCanvas?.document.nodes.map((n) => n.id)).toEqual(["a"]);
    // result 到达后结算。
    store.applyResult({ commandId: "cmd-1", status: "accepted", revision: 1 });
    expect(store.pendingBatches).toHaveLength(0);
  });

  it("拖拽坐标被服务端吸附后，accepted revision 覆盖即结算", () => {
    const seeded = advance(baseCanvas(), [
      { type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } }
    ], 1);
    const drag = { type: "node.update", nodeId: "a", position: { x: 85.1, y: 95.61 } } as const;
    store.applyCanonical(seeded);
    store.appendBatch({
      commandId: "web-drag-test",
      baseRevision: 1,
      submittedAt: NOW,
      commands: [drag]
    });
    store.applyResult({ commandId: "web-drag-test", status: "accepted", revision: 2 });
    expect(store.pendingBatches).toHaveLength(1);

    store.applyCanonical(advance(seeded, [drag], 2));
    expect(store.canonicalCanvas?.document.nodes[0]?.position).toEqual({ x: 85, y: 95.5 });
    expect(store.pendingBatches).toHaveLength(0);
  });

  it("拖拽 update 先于 result 到达时按吸附后的坐标识别效果", () => {
    const seeded = advance(baseCanvas(), [
      { type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } }
    ], 1);
    const drag = { type: "node.update", nodeId: "a", position: { x: 85.1, y: 95.61 } } as const;
    store.applyCanonical(seeded);
    store.appendBatch({
      commandId: "web-drag-update-first",
      baseRevision: 1,
      submittedAt: NOW,
      commands: [drag]
    });

    store.applyCanonical(advance(seeded, [drag], 2));
    expect(store.pendingBatches).toHaveLength(0);
  });

  it("拒绝后移除批次并重放后续", () => {
    store.applyCanonical(baseCanvas());
    store.appendBatch({
      commandId: "cmd-1",
      baseRevision: 0,
      submittedAt: NOW,
      commands: [{ type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } }]
    });
    store.appendBatch({
      commandId: "cmd-2",
      baseRevision: 0,
      submittedAt: NOW,
      commands: [{ type: "node.add", node: { id: "b", type: "image", position: { x: 200, y: 0 } } }]
    });
    expect(store.workingCanvas?.document.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    store.applyResult({ commandId: "cmd-1", status: "rejected", code: "domain-rejected", error: "领域拒绝" });
    // 被拒绝的 cmd-1 立即出队；与它无关的 cmd-2 继续等待服务端确认。
    expect(store.pendingBatches.map((b) => b.commandId)).toEqual(["cmd-2"]);
    expect(store.pendingBatches[0].state).toBe("pending");
    expect(store.workingCanvas?.document.nodes.map((node) => node.id)).toEqual(["b"]);
    expect(store.lastRejections).toContainEqual({
      commandId: "cmd-1",
      code: "domain-rejected",
      message: "领域拒绝"
    });
  });

  it("单条命令被服务端拒绝后不残留待保存项", () => {
    store.applyCanonical(baseCanvas());
    store.appendBatch({
      commandId: "cmd-rejected",
      baseRevision: 0,
      submittedAt: NOW,
      commands: [{ type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } }]
    });

    store.applyResult({ commandId: "cmd-rejected", status: "failed", error: "存储失败" });

    expect(store.pendingBatches).toHaveLength(0);
    expect(store.workingCanvas?.document.nodes).toEqual([]);
    expect(store.lastRejections[0]).toMatchObject({ commandId: "cmd-rejected", code: "failed" });
  });

  it("远端删除 pending 目标 → 批次 blocked，working 不重建该节点", () => {
    const seeded = advance(baseCanvas(), [
      { type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } }
    ], 1);
    store.applyCanonical(seeded);
    store.appendBatch({
      commandId: "cmd-1",
      baseRevision: 1,
      submittedAt: NOW,
      commands: [{ type: "node.update", nodeId: "a", position: { x: 50, y: 50 } }]
    });
    expect(store.workingCanvas?.document.nodes[0].position).toEqual({ x: 50, y: 50 });
    // 远端删除 a。
    store.applyCanonical(advance(seeded, [{ type: "node.remove", nodeIds: ["a"] }], 2));
    expect(store.workingCanvas?.document.nodes).toEqual([]);
    expect(store.pendingBatches[0].state).toBe("blocked");
  });

  it("no-op：result revision 等于 base 且 canonical 已覆盖时结算", () => {
    const canonical = baseCanvas();
    store.applyCanonical(canonical);
    store.appendBatch({
      commandId: "cmd-noop",
      baseRevision: 0,
      submittedAt: NOW,
      // 删除一个不存在的 nodeData 键：合法且无净变化（no-op）。
      commands: [{ type: "nodeData.patch", nodeId: "ghost", value: null }]
    });
    store.applyResult({ commandId: "cmd-noop", status: "accepted", revision: 0 });
    expect(store.pendingBatches).toHaveLength(0);
  });

  it("storage failed → rejected 情形回滚 pending", () => {
    store.applyCanonical(baseCanvas());
    store.appendBatch({
      commandId: "cmd-1",
      baseRevision: 0,
      submittedAt: NOW,
      commands: [{ type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } }]
    });
    store.applyResult({ commandId: "cmd-1", status: "failed", error: "storage-failed" });
    expect(store.pendingBatches).toHaveLength(0);
    expect(store.lastRejections[0]).toMatchObject({
      commandId: "cmd-1",
      code: "failed",
      message: "storage-failed"
    });
  });

  it("远端无关更新：pending effect 保留，canonical 无关字段不被旧基线覆盖", () => {
    const seeded = advance(baseCanvas(), [
      { type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } }
    ], 1);
    store.applyCanonical(seeded);
    // 本页 pending：移动 a。
    store.appendBatch({
      commandId: "cmd-1",
      baseRevision: 1,
      submittedAt: NOW,
      commands: [{ type: "node.update", nodeId: "a", position: { x: 99, y: 99 } }]
    });
    // 远端新增无关节点 b。
    store.applyCanonical(advance(seeded, [
      { type: "node.add", node: { id: "b", type: "image", position: { x: 500, y: 0 } } }
    ], 2));
    // 远端 b 可见 + 本页 a 的 pending 位移仍然生效。
    const ids = store.workingCanvas?.document.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["a", "b"]);
    expect(store.workingCanvas?.document.nodes.find((n) => n.id === "a")?.position).toEqual({ x: 99, y: 99 });
  });

  it("同字段远端更新：pending effect 在未结算时覆盖显示", () => {
    const seeded = advance(baseCanvas(), [
      { type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } }
    ], 1);
    store.applyCanonical(seeded);
    store.appendBatch({
      commandId: "cmd-1",
      baseRevision: 1,
      submittedAt: NOW,
      commands: [{ type: "node.update", nodeId: "a", position: { x: 10, y: 10 } }]
    });
    // 远端把 a 移到别处。
    store.applyCanonical(advance(seeded, [
      { type: "node.update", nodeId: "a", position: { x: 77, y: 77 } }
    ], 2));
    // pending 效果仍覆盖显示（design D5 风险项：远端同字段修改时 pending 覆盖显示）。
    expect(store.workingCanvas?.document.nodes[0].position).toEqual({ x: 10, y: 10 });
    expect(store.canonicalCanvas?.document.nodes[0].position).toEqual({ x: 77, y: 77 });
  });
});

describe("发送失败与断线", () => {
  it("发送失败移除批次并重放剩余", () => {
    store.applyCanonical(baseCanvas());
    store.appendBatch({
      commandId: "cmd-1",
      baseRevision: 0,
      submittedAt: NOW,
      commands: [{ type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } }]
    });
    store.rejectBatch("cmd-1", "socket 未就绪");
    expect(store.pendingBatches).toHaveLength(0);
    expect(store.workingCanvas?.document.nodes).toEqual([]);
    expect(store.lastRejections[0].code).toBe("send-failed");
  });

  it("断线标记 unknown 不丢弃 pending、不写离线 outbox", () => {
    store.applyCanonical(baseCanvas());
    store.appendBatch({
      commandId: "cmd-1",
      baseRevision: 0,
      submittedAt: NOW,
      commands: [{ type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } }]
    });
    store.markUnknown();
    expect(store.pendingBatches).toHaveLength(1);
  });
});

describe("canonical-only 与 working 选择器分离", () => {
  it("canonicalSelector 不含 pending 效果，workingSelector 含", () => {
    store.applyCanonical(baseCanvas());
    store.appendBatch({
      commandId: "cmd-1",
      baseRevision: 0,
      submittedAt: NOW,
      commands: [{ type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } }]
    });
    expect(store.canonicalSelector()?.document.nodes).toEqual([]);
    expect(store.workingSelector()?.document.nodes.map((n) => n.id)).toEqual(["a"]);
  });
});
