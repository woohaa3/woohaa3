import { describe, expect, it } from "vitest";
import { createModelScriptReports } from "./model-script-reports.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const value = (nodeId: string, status: "ok" | "failed" = "ok") => ({ canvasId: "c", nodeId, status });

/** Resolves when the queue is idle again (no running drain). */
const settle = async () => {
  for (let step = 0; step < 8; step += 1) await tick();
};

describe("model report queue", () => {
  it("保持串行并合并未发送节点的新结果", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const sent: ReturnType<typeof value>[] = [];
    const queue = createModelScriptReports(async report => {
      sent.push(report);
      if (report.nodeId === "first") await held;
    });
    queue.enqueue(value("first"), 1, () => true);
    queue.enqueue(value("second", "failed"), 1, () => true);
    queue.enqueue(value("second"), 1, () => true);
    queue.enqueue(value("deleted"), 1, () => false);
    expect(sent).toEqual([value("first")]);
    release();
    await settle();
    expect(sent).toEqual([value("first"), value("second")]);
    queue.dispose();
  });

  it("失败后继续；释放后不再发送排队的结果", async () => {
    let reject!: (error: Error) => void;
    const held = new Promise<void>((_, fail) => { reject = fail; });
    const sent: string[] = [];
    const queue = createModelScriptReports(async report => {
      sent.push(report.nodeId);
      if (report.nodeId === "first") await held;
      if (report.nodeId === "second") throw new Error("offline");
    });
    queue.enqueue(value("first"), 1, () => true);
    queue.enqueue(value("second"), 1, () => true);
    queue.enqueue(value("third"), 1, () => true);
    reject(new Error("offline"));
    await settle();
    expect(sent).toEqual(["first", "second", "third"]);
    queue.dispose();
    queue.enqueue(value("after-dispose"), 1, () => true);
    expect(sent).toHaveLength(3);
  });

  it("释放正在等待的队列会撤销后续上报", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const sent: string[] = [];
    const queue = createModelScriptReports(async report => { sent.push(report.nodeId); await held; });
    queue.enqueue(value("first"), 1, () => true);
    queue.enqueue(value("second"), 1, () => true);
    queue.dispose();
    release();
    await settle();
    expect(sent).toEqual(["first"]);
  });

  // A→B→A: the queued A report must not run against the second A visit.
  it("旧画布访问的排队上报在回到同一画布后不再发送", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const sent: string[] = [];
    const queue = createModelScriptReports(async report => {
      sent.push(report.nodeId);
      await held;
    });
    queue.enqueue(value("node"), 1, () => true);
    let visitA = true;
    queue.enqueue(value("node"), 1, () => visitA);
    // Switch canvases: the second visit owns the pending status now.
    visitA = false;
    expect(queue.hasPending(1, "node")).toBe(true);
    release();
    await settle();
    expect(sent).toEqual(["node"]);
    queue.dispose();
  });

  it("过期条目不会压住同一画布新访问的新结果", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const sent: ReturnType<typeof value>[] = [];
    const queue = createModelScriptReports(async report => { sent.push(report); await held; });
    // Visit 1 queues an outcome that is already stale by the time the first send returns.
    let visitA = true;
    queue.enqueue(value("first"), 1, () => true);
    queue.enqueue(value("node", "failed"), 1, () => visitA);
    visitA = false;
    // Visit 1 ends and visit 2 produces a fresh outcome for the same node.
    queue.enqueue(value("node"), 2, () => true);
    expect(queue.hasPending(2, "node")).toBe(true);
    release();
    await settle();
    expect(sent).toEqual([value("first"), value("node")]);
    queue.dispose();
  });

  it("同一画布 renderer 重建后的旧排队结果被拒绝，新结果照常上报", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const sent: string[] = [];
    const queue = createModelScriptReports(async report => { sent.push(`${report.nodeId}:${report.status}`); await held; });
    // Same canvas id and node key, but visit 1.
    queue.enqueue(value("first"), 1, () => true);
    queue.enqueue(value("node", "failed"), 1, () => true);
    // Renderer recreated on the same canvas: visit 2 now owns the status, and the plugin drops
    // every queued entry of the superseded visit.
    queue.retain(visit => visit === 2);
    queue.enqueue(value("node"), 2, () => true);
    release();
    await settle();
    expect(sent).toEqual(["first:ok", "node:ok"]);
    queue.dispose();
  });

  it("正在发送的旧画布上报不会阻止新画布重新入队", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const sent: string[] = [];
    const queue = createModelScriptReports(async report => {
      sent.push(`${report.canvasId}:${report.nodeId}`);
      if (report.canvasId === "a") await held;
    });
    queue.enqueue({ canvasId: "a", nodeId: "node", status: "failed" }, 1, () => true);
    // The canvas switches while the visit-1 request is still in flight.
    expect(queue.hasPending(1, "node")).toBe(true);
    expect(queue.hasPending(2, "node")).toBe(false);
    queue.enqueue({ canvasId: "b", nodeId: "node", status: "ok" }, 2, () => true);
    release();
    await settle();
    expect(sent).toEqual(["a:node", "b:node"]);
    queue.dispose();
  });

  // A→B→A must not be suppressed: the pending entry of visit 1 is invisible to visit 2, so the
  // caller's `hasPending` shortcut cannot skip reporting the new visit's outcome.
  it("A→B→A 的旧访问待发上报不抑制新访问的新上报", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const sent: string[] = [];
    const queue = createModelScriptReports(async report => { sent.push(`${report.canvasId}:${report.nodeId}:${report.status}`); await held; });
    // Visit 1 (canvas a) queues a failure that is still waiting when the canvas switches.
    queue.enqueue({ canvasId: "a", nodeId: "node", status: "failed" }, 1, () => true);
    // Visit 2 (canvas b) then visit 3 (canvas a again, same node key).
    expect(queue.hasPending(3, "node")).toBe(false);
    queue.enqueue({ canvasId: "a", nodeId: "node", status: "ok" }, 3, () => true);
    release();
    await settle();
    expect(sent).toEqual(["a:node:failed", "a:node:ok"]);
    queue.dispose();
  });

  // A renderer recreation keeps the canvas id and node key; only the visit differs. The stale
  // entry must neither be sent nor hide the new outcome.
  it("同一画布 renderer 重建的待发上报不遮蔽新作用域结果", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const sent: string[] = [];
    const queue = createModelScriptReports(async report => { sent.push(`${report.nodeId}:${report.status}`); await held; });
    queue.enqueue(value("node", "failed"), 7, () => true);
    expect(queue.hasPending(8, "node")).toBe(false);
    queue.enqueue(value("node"), 8, () => true);
    release();
    await settle();
    expect(sent).toEqual(["node:failed", "node:ok"]);
    queue.dispose();
  });

  it("retain 只保留仍在的访问条目", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const sent: string[] = [];
    const queue = createModelScriptReports(async report => { sent.push(`${report.canvasId}:${report.nodeId}`); await held; });
    queue.enqueue({ canvasId: "a", nodeId: "blocker", status: "ok" }, 1, () => true);
    queue.enqueue({ canvasId: "a", nodeId: "old", status: "ok" }, 1, () => true);
    queue.enqueue({ canvasId: "b", nodeId: "fresh", status: "ok" }, 2, () => true);
    queue.retain(visit => visit === 2);
    release();
    await settle();
    expect(sent).toEqual(["a:blocker", "b:fresh"]);
    queue.dispose();
  });
});
