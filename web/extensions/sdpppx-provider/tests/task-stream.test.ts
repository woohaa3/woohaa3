import { describe, expect, it, vi } from "vitest";
import {
  CreateTaskError,
  createTaskStreamTracker,
  parseSseBlock
} from "../src/backend/task-stream.js";
import { createFetch, sseResponse, textResponse } from "./helpers.js";

function startOptions(fetchImpl: typeof globalThis.fetch) {
  return {
    fetchImpl,
    url: "https://sdpppx.example/tasks/create_stream",
    accessToken: "jwt-1",
    tenantId: "tenant-1",
    templateId: "tpl-1",
    payload: { prompt: "p" }
  };
}

describe("parseSseBlock", () => {
  it("解析 event/data，兼容 CRLF 与多行 data", () => {
    expect(parseSseBlock('event: created\ndata: {"job_id":"t1"}')).toEqual({
      event: "created",
      data: { job_id: "t1" }
    });
    expect(parseSseBlock('event: status\r\ndata: {"status":"running"}')).toEqual({
      event: "status",
      data: { status: "running" }
    });
    expect(parseSseBlock("data: not-json")).toBeNull();
    expect(parseSseBlock(": keep-alive")).toBeNull();
  });
});

describe("createTaskStreamTracker", () => {
  it("从 SSE 的 created 事件取任务 ID，并继续读完结果", async () => {
    const { fetchImpl, calls } = createFetch(() =>
      sseResponse([
        { event: "created", data: { job_id: "task-1", status: "queued" } },
        { event: "status", data: { status: "running" } },
        { event: "result", data: { status: "succeeded", result: [{ url: "https://cdn.example/1.png" }] } },
        { event: "done", data: { job_id: "task-1" } }
      ])
    );
    const tracker = createTaskStreamTracker();
    const started = await tracker.start(startOptions(fetchImpl));
    expect(started.taskId).toBe("task-1");
    expect(calls[0]!.url).toBe("https://sdpppx.example/tasks/create_stream");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      tenantId: "tenant-1",
      templateId: "tpl-1",
      payload: { prompt: "p" }
    });

    await vi.waitFor(() => {
      expect(tracker.lookup("task-1")?.finished).toBe(true);
    });
    expect(tracker.lookup("task-1")).toMatchObject({
      status: "succeeded",
      outputs: [{ url: "https://cdn.example/1.png" }],
      failureCode: null,
      streamError: false
    });
  });

  it("跨 chunk 的 created 事件也能识别", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: created\ndata: {"job_'));
        setTimeout(() => {
          controller.enqueue(encoder.encode('id":"task-2"}\n\n'));
          controller.close();
        }, 0);
      }
    });
    const tracker = createTaskStreamTracker();
    const started = await tracker.start(
      startOptions(vi.fn(async () => new Response(body, { headers: { "content-type": "text/event-stream" } })) as never)
    );
    expect(started.taskId).toBe("task-2");
  });

  it("HTTP 402 带服务端错误值时抛 rejected，并保留稳定原因", async () => {
    const { fetchImpl } = createFetch(() =>
      textResponse(JSON.stringify({ error: "INSUFFICIENT_BALANCE" }), {
        status: 402,
        headers: { "content-type": "application/json" }
      })
    );
    const tracker = createTaskStreamTracker();
    await expect(tracker.start(startOptions(fetchImpl))).rejects.toMatchObject({
      kind: "rejected",
      status: 402,
      reason: "INSUFFICIENT_BALANCE",
      message: "账户余额不足"
    });
  });

  it("401 标记 unauthorized，由调用方清会话", async () => {
    const { fetchImpl } = createFetch(() => textResponse("no", { status: 401 }));
    const tracker = createTaskStreamTracker();
    await expect(tracker.start(startOptions(fetchImpl))).rejects.toBeInstanceOf(CreateTaskError);
    await expect(tracker.start(startOptions(fetchImpl))).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("200 但不是事件流、或流在 created 前结束，判协议错误", async () => {
    const { fetchImpl } = createFetch(() => textResponse("{}", { status: 200 }));
    const tracker = createTaskStreamTracker();
    await expect(tracker.start(startOptions(fetchImpl))).rejects.toMatchObject({ kind: "protocol" });

    const empty = createFetch(() => sseResponse([{ event: "status", data: { status: "queued" } }]));
    const emptyTracker = createTaskStreamTracker();
    await expect(emptyTracker.start(startOptions(empty.fetchImpl))).rejects.toMatchObject({ kind: "protocol" });
  });

  it("失败终态写入 failureCode；轮询超时只标记回退，不判任务失败", async () => {
    const failed = createFetch(() =>
      sseResponse([
        { event: "created", data: { job_id: "task-3", status: "queued" } },
        { event: "error", data: { status: "failed", error: "boom" } },
        { event: "done", data: { job_id: "task-3" } }
      ])
    );
    const failedTracker = createTaskStreamTracker();
    await failedTracker.start(startOptions(failed.fetchImpl));
    await vi.waitFor(() => {
      expect(failedTracker.lookup("task-3")?.failureCode).toBe("sdpppx-task-failed");
    });

    const timeout = createFetch(() =>
      sseResponse([
        { event: "created", data: { job_id: "task-4", status: "queued" } },
        { event: "error", data: { error: "Polling timeout - task still not completed" } }
      ])
    );
    const timeoutTracker = createTaskStreamTracker();
    await timeoutTracker.start(startOptions(timeout.fetchImpl));
    await vi.waitFor(() => {
      expect(timeoutTracker.lookup("task-4")?.streamError).toBe(true);
    });
    expect(timeoutTracker.lookup("task-4")?.failureCode).toBeNull();
  });
});
