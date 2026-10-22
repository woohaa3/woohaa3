/**
 * ChatGPT durable 工作日志测试
 * （change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 4.1/4.4/4.6 / design D6/D7）。
 *
 * 覆盖：受理意图持久化、owner/epoch/输入身份绑定、重启恢复把中断工作标记 outcome-unknown、
 * 断开改变授权 epoch。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { priorToReceipt } from "../src/backend/generation/receipts.js";
import { createChatGptWorkJournal } from "../src/backend/work-journal.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "chatgpt-journal-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ChatGptWorkJournal", () => {
  it("受理意图持久化 owner 摘要/输入身份/epoch，可按 requestId+owner 读回", () => {
    const journal = createChatGptWorkJournal({ directory: tempDir() });
    const record = journal.admit({
      requestId: "r1",
      ownerId: "owner-a",
      authEpoch: journal.authEpoch(),
      inputIdentity: "ident-1",
      canvasId: "c1",
      nodeId: "n1",
      mode: "model3d"
    });
    expect(record.state).toBe("admitted");
    expect(record.ownerHash).not.toContain("owner-a");
    const found = journal.find("r1", "owner-a");
    expect(found?.inputIdentity).toBe("ident-1");
    // 不同 owner 不可见。
    expect(journal.find("r1", "owner-b")).toBeUndefined();
  });

  it("重启恢复把 admitted/running 标记 outcome-unknown 且不丢失终态", () => {
    const dir = tempDir();
    const first = createChatGptWorkJournal({ directory: dir });
    const admitted = first.admit({ requestId: "r1", ownerId: "o", authEpoch: 0, inputIdentity: "i1", canvasId: "c", nodeId: "n", mode: "model3d" });
    const running = first.admit({ requestId: "r2", ownerId: "o", authEpoch: 0, inputIdentity: "i2", canvasId: "c", nodeId: "n", mode: "camera" });
    first.update(running.workId, { state: "running" });
    const committed = first.admit({ requestId: "r3", ownerId: "o", authEpoch: 0, inputIdentity: "i3", canvasId: "c", nodeId: "n", mode: "model3d" });
    first.update(committed.workId, { state: "committed", commandId: "cmd-3" });

    // 模拟进程重启：新建 journal 读同一目录。
    const second = createChatGptWorkJournal({ directory: dir });
    const interrupted = second.recoverInterrupted();
    expect(interrupted.map((r) => r.requestId).sort()).toEqual(["r1", "r2"]);
    expect(second.find("r1", "o")?.state).toBe("outcome-unknown");
    expect(second.find("r2", "o")?.state).toBe("outcome-unknown");
    // 已提交的确定终态不被改写。
    expect(second.find("r3", "o")?.state).toBe("committed");
    expect(second.find("r3", "o")?.commandId).toBe("cmd-3");
    void admitted;
  });

  it("断开改变授权 epoch（旧在途工作据此失效）", () => {
    const journal = createChatGptWorkJournal({ directory: tempDir() });
    expect(journal.authEpoch()).toBe(0);
    expect(journal.bumpAuthEpoch()).toBe(1);
    expect(journal.authEpoch()).toBe(1);
  });
  it("restart keeps captured clip, actor and LLM output in a terminal receipt", () => {
    const directory = tempDir(); const journal = createChatGptWorkJournal({ directory });
    const admitted = journal.admit({ requestId: "clip", ownerId: "o", authEpoch: 0, inputIdentity: "i", canvasId: "c", nodeId: "n", mode: "film-set", clipId: "jump", itemId: "hero" });
    journal.update(admitted.workId, { state: "failed", code: "unknown-clip", message: "已删除", llmOutput: "模型回复正文" });
    const recovered = createChatGptWorkJournal({ directory }).find("clip", "o")!;
    expect(recovered.itemId).toBe("hero");
    expect(priorToReceipt(recovered)).toMatchObject({ status: "failed", clipId: "jump", llmOutput: "模型回复正文" });
  });

});
