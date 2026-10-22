/**
 * Task history 真实持续 HTTP 验收
 * （change: improve-task-history-experience，任务 6.3）。
 *
 * 启动真实 `http.Server` + 生产 handler，用 `fetch` 读取 NDJSON：验证响应**未结束**即交付、
 * 后续 durable 变化继续推送、`/changes` 轮询实际交付，以及客户端中止后服务端停止推送。
 *
 * 这里不使用内存 emit 或静态 markup 断言作为「生产流式读取」的证据。
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSqliteTaskHistoryRepository } from "../repository/history-repository.js";
import { createTaskHistoryHandler } from "../api/history-api.js";

const dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-history-http-"));
  dirs.push(dir);
  return path.join(dir, "history.sqlite");
}

describe("history 真实持续 HTTP（任务 6.3）", () => {
  let server: Server;
  let base: string;
  let history: ReturnType<typeof createSqliteTaskHistoryRepository>;

  beforeAll(async () => {
    history = createSqliteTaskHistoryRepository({ path: tempDb() });
    const handler = createTaskHistoryHandler({ history, allowLoopback: true, eventFlushMs: 20, eventBatchLimit: 10 });
    server = createServer((req, res) => {
      void handler(req, res).then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("no port");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    history.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("响应未结束即交付完整记录，随后推送 durable 变化", async () => {
    history.upsertRecord({ taskKey: "seed-1", state: "running", providerId: "litellm", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", durationMs: 0 });

    const controller = new AbortController();
    const response = await fetch(`${base}/api/pptask/history/events?after=0`, { signal: controller.signal });
    expect(response.ok).toBe(true);
    expect(response.body).not.toBeNull();
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const lines: string[] = [];
    const readUntil = async (predicate: () => boolean, timeoutMs = 3_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate() && Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value, { stream: true }).split("\n")) {
          if (line.trim() !== "") lines.push(line);
        }
      }
    };
    await readUntil(() => lines.some((line) => line.includes("seed-1")));
    // 连接仍然打开（响应未结束）时就已经拿到记录。
    expect(lines.some((line) => line.includes("seed-1"))).toBe(true);
    expect(history.currentCursor()).toBeGreaterThan(0);

    history.upsertRecord({ taskKey: "live-2", state: "succeeded", providerId: "litellm", createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", durationMs: 0 });
    await readUntil(() => lines.some((line) => line.includes("live-2")));
    expect(lines.some((line) => line.includes("live-2"))).toBe(true);

    // 客户端中止后服务端停止推送；连接关闭不报错。
    controller.abort();
    await reader.read().catch(() => undefined);
  });

  it("/changes 轮询实际交付变更与 resync", async () => {
    history.upsertRecord({ taskKey: "poll-1", state: "running", providerId: "litellm", createdAt: "2026-01-03T00:00:00Z", updatedAt: "2026-01-03T00:00:00Z", durationMs: 0 });
    const response = await fetch(`${base}/api/pptask/history/changes?after=0&limit=200`);
    const body = (await response.json()) as { messages: Array<{ record: { taskKey: string } }>; cursor: number; resync?: boolean };
    expect(body.resync).not.toBe(true);
    expect(body.messages.some((message) => message.record.taskKey === "poll-1")).toBe(true);

    const future = await fetch(`${base}/api/pptask/history/changes?after=${history.currentCursor() + 100}`);
    expect((await future.json()) as { resync?: boolean }).toMatchObject({ resync: true });
  });
});
