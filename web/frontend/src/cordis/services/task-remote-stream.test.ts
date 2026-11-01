/**
 * Task Remote 真实传输消费测试
 * （change: improve-task-history-experience，任务 2.4/2.5/6.3）。
 *
 * 用受控 ReadableStream 验证：响应**未结束**即交付、跨 chunk 行、UTF-8、畸形消息 resync、
 * 流不可用时以 `/changes` 轮询**实际交付**，以及释放后停止。
 */
import { describe, expect, it, vi } from "vitest";
import { createTaskRemote } from "./task-remote.js";
import type { TaskExecutionSummary } from "@woohaa3/contracts";

function record(taskKey: string, revision: number): TaskExecutionSummary {
  return {
    taskKey,
    state: "running",
    providerId: "litellm",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:01Z",
    durationMs: 1000,
    recordRevision: revision
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function controllableStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    }
  });
  return {
    stream,
    send: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
    sendBytes: (bytes: Uint8Array) => controller.enqueue(bytes),
    close: () => controller.close()
  };
}

function ndjsonResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Task Remote 真实流式消费", () => {
  it("响应尚未结束即交付完整消息，并推进 cursor", async () => {
    const { stream, send } = controllableStream();
    const remote = createTaskRemote({
      fetchImpl: (async () => ndjsonResponse(stream)) as unknown as typeof fetch
    });
    const received: number[] = [];
    const unsubscribe = remote.createHistory().subscribe({
      cursor: 0,
      onRecord: (_record, cursor) => received.push(cursor)
    });
    send(`${JSON.stringify({ record: record("t1", 5), cursor: 5 })}\n`);
    await wait(20);
    // 流仍然打开（未 close），但消息已经交付。
    expect(received).toEqual([5]);
    unsubscribe();
  });

  it("跨 chunk 的行与 UTF-8 正确拼接", async () => {
    const { stream, sendBytes } = controllableStream();
    const remote = createTaskRemote({
      fetchImpl: (async () => ndjsonResponse(stream)) as unknown as typeof fetch
    });
    const received: string[] = [];
    const unsubscribe = remote.createHistory().subscribe({
      cursor: 0,
      onRecord: (summary) => received.push(summary.taskKey)
    });
    const message = { record: record("任务-α", 7), cursor: 7 };
    const bytes = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
    // 在中文字符中间切分，验证 UTF-8 增量解码。
    sendBytes(bytes.slice(0, 12));
    await wait(10);
    sendBytes(bytes.slice(12));
    await wait(20);
    expect(received).toEqual(["任务-α"]);
    unsubscribe();
  });

  it("畸形完整行触发 resync，不跳过缺口确认更大 cursor", async () => {
    const { stream, send } = controllableStream();
    const remote = createTaskRemote({
      fetchImpl: (async () => ndjsonResponse(stream)) as unknown as typeof fetch
    });
    const resync = vi.fn();
    const unsubscribe = remote.createHistory().subscribe({
      cursor: 3,
      onRecord: () => undefined,
      onResync: resync
    });
    send("这不是 JSON\n");
    await wait(20);
    expect(resync).toHaveBeenCalled();
    unsubscribe();
  });

  it("流正常结束且轮询可用时保持实时状态，不闪重连中", async () => {
    const statuses: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("/events")) {
        const { stream, close } = controllableStream();
        queueMicrotask(() => close());
        return ndjsonResponse(stream);
      }
      return jsonResponse({ messages: [], cursor: 0, hasMore: false });
    });
    const remote = createTaskRemote({ fetchImpl: fetchImpl as unknown as typeof fetch, pollIntervalMs: 5 });
    const unsubscribe = remote.createHistory().subscribe({
      cursor: 0,
      onRecord: () => undefined,
      onStatus: status => statuses.push(status.state)
    });
    await wait(40);
    unsubscribe();
    expect(statuses).toContain("live");
    expect(statuses).not.toContain("reconnecting");
  });

  it("流不可用时轮询 /changes 实际交付变更", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("/events")) return new Response(null, { status: 204 });
      if (String(url).includes("/changes")) {
        return jsonResponse({ messages: [{ record: record("polled", 9), cursor: 9 }], cursor: 9, hasMore: false });
      }
      return jsonResponse({ items: [], watermark: 0 });
    });
    const remote = createTaskRemote({ fetchImpl: fetchImpl as unknown as typeof fetch, pollIntervalMs: 5 });
    const received: Array<{ key: string; cursor: number }> = [];
    const unsubscribe = remote.createHistory().subscribe({
      cursor: 0,
      onRecord: (summary, cursor) => received.push({ key: summary.taskKey, cursor })
    });
    await wait(40);
    unsubscribe();
    expect(received).toEqual([{ key: "polled", cursor: 9 }]);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/changes"))).toBe(true);
  });

  it("释放后中止流请求，迟到消息不再交付", async () => {
    const { stream, send } = controllableStream();
    let aborted = false;
    const remote = createTaskRemote({
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
          resolve(ndjsonResponse(stream));
        })) as unknown as typeof fetch
    });
    const received: string[] = [];
    const unsubscribe = remote.createHistory().subscribe({
      cursor: 0,
      onRecord: (summary) => received.push(summary.taskKey)
    });
    send(`${JSON.stringify({ record: record("t1", 1), cursor: 1 })}\n`);
    await wait(15);
    expect(received).toEqual(["t1"]);
    unsubscribe();
    await wait(20);
    expect(aborted).toBe(true);
  });
});
