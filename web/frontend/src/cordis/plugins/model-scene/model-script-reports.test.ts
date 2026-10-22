import { describe, expect, it } from "vitest";
import { createModelScriptReports } from "./model-script-reports.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const value = (nodeId: string, status: "ok" | "failed" = "ok") => ({ canvasId: "c", nodeId, status });

describe("model report queue", () => {
  it("保持串行并合并未发送节点的新结果", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const sent: ReturnType<typeof value>[] = [];
    const queue = createModelScriptReports(async report => {
      sent.push(report);
      if (report.nodeId === "first") await held;
    });
    queue.enqueue(value("first"), () => true);
    queue.enqueue(value("second", "failed"), () => true);
    queue.enqueue(value("second"), () => true);
    queue.enqueue(value("deleted"), () => false);
    expect(sent).toEqual([value("first")]);
    release();
    await tick();
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
    queue.enqueue(value("first"), () => true);
    queue.enqueue(value("second"), () => true);
    queue.enqueue(value("third"), () => true);
    reject(new Error("offline"));
    await tick();
    expect(sent).toEqual(["first", "second", "third"]);
    queue.dispose();
    queue.enqueue(value("after-dispose"), () => true);
    expect(sent).toHaveLength(3);
  });

  it("释放正在等待的队列会撤销后续上报", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const sent: string[] = [];
    const queue = createModelScriptReports(async report => { sent.push(report.nodeId); await held; });
    queue.enqueue(value("first"), () => true);
    queue.enqueue(value("second"), () => true);
    queue.dispose();
    release();
    await tick();
    expect(sent).toEqual(["first"]);
  });
});
