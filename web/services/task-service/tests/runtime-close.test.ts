/**
 * 优雅停机等待在飞媒体转存（修复：重启/停机落在终态投影窗口会丢 history 终态）。
 *
 * 覆盖：
 * 1. 停机时等转存完成，终态 succeeded 已写入 history 才返回；
 * 2. 超宽限仍未完成时 close 仍按时返回，并记录 timeout 日志（记录留给下次启动的终态对账）。
 */
import { describe, expect, it } from "vitest";
import type { PptaskTaskRecord, PptaskTaskStore, PptaskWorkerServer } from "@sdppp/pptask-worker-server";
import type { ExecutionRecord } from "@sdppp/pptask-worker-server/history";
import type { TaskExecutionState } from "@woohaa3/contracts";
import type { MediaClient } from "../src/clients/media-client.js";
import type { SqliteTaskHistoryRepository } from "../src/repository/history-repository.js";
import { createTaskRuntime } from "../src/worker/runtime.js";

const IMAGE_KEY = `generation-outputs/${"e".repeat(64)}.png`;

function metadata() {
  return { storageKey: IMAGE_KEY, contentType: "image/png", size: 3, checksum: "e".repeat(64), mediaKind: "image" as const };
}

function executionRecord(): ExecutionRecord {
  return {
    id: "run-1",
    providerId: "tokenhub",
    modelType: "image",
    state: "succeeded",
    result: {
      outputCount: 1,
      outputs: [{ kind: "image", url: "https://provider.example/a.png" }],
      value: undefined
    },
    events: [],
    createdAt: "2026-10-20T10:57:52.202Z",
    updatedAt: "2026-10-20T10:58:16.126Z",
    finishedAt: "2026-10-20T10:58:16.126Z",
    durationMs: 1_000
  };
}

function harness(options: { importFromUrl: (input: { url: string }) => Promise<ReturnType<typeof metadata>> }) {
  const records: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const logs: Array<Record<string, unknown>> = [];
  const history = {
    upsertRecord: (input: Record<string, unknown>) => {
      records.push(input);
      return 1;
    },
    appendEvent: (input: Record<string, unknown>) => {
      events.push(input);
      return 1;
    },
    lastEventTail: () => undefined,
    lastEvent: () => undefined,
    stateOf: () => "running" as TaskExecutionState
  } as unknown as SqliteTaskHistoryRepository;
  const mediaClient = {
    verify: async () => ({ exists: true, matches: true }),
    sign: async () => "https://cos.example/signed",
    importFromUrl: (input: { url: string }) => options.importFromUrl(input),
    importBytes: async () => metadata()
  } as unknown as MediaClient;
  const taskStore = { find: async () => null } as unknown as PptaskTaskStore;

  let listener: ((record: ExecutionRecord) => void) | undefined;
  let stopped = false;
  const server = {
    submit: async () => ({ created: true, record: { key: "run-1", providerId: "tokenhub", status: "queued", attempt: 0 } }),
    cancel: async () => undefined,
    status: async () => null,
    history: { subscribe: () => () => undefined },
    subscribe: (fn: (record: ExecutionRecord) => void) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    stop: () => {
      stopped = true;
    },
    drained: async () => undefined,
    abortAll: () => undefined,
    close: async () => undefined
  } as unknown as PptaskWorkerServer;

  return {
    records,
    events,
    logs,
    stopped: () => stopped,
    emit: () => listener?.(executionRecord()),
    create: (shutdownGraceMs: number) =>
      createTaskRuntime({
        taskStore,
        history,
        provider: {} as never,
        providerId: "tokenhub",
        mediaClient,
        server,
        shutdownGraceMs,
        logger: (event) => logs.push(event),
        resolveAssociation: () => ({ canvasId: "canvas-1", nodeId: "node-1", runId: "run-1", jobId: "job-1" })
      })
  };
}

describe("runtime.close 等待在飞媒体转存", () => {
  it("转存完成并写入 succeeded 后才返回", async () => {
    let imported = false;
    const h = harness({
      importFromUrl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        imported = true;
        return metadata();
      }
    });
    const runtime = await h.create(5_000);
    h.emit();
    const startedAt = Date.now();
    await runtime.close();
    expect(imported).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);
    expect(h.records.at(-1)).toMatchObject({ taskKey: "run-1", state: "succeeded", result: { storageKey: IMAGE_KEY } });
    expect(h.stopped()).toBe(true);
  });

  it("超过停机宽限仍未完成时按时返回并记录 timeout（留给下次启动对账）", async () => {
    const h = harness({
      importFromUrl: () => new Promise<ReturnType<typeof metadata>>(() => undefined)
    });
    const runtime = await h.create(20);
    h.emit();
    const startedAt = Date.now();
    await runtime.close();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    // 停机时只剩「媒体准备中」的非终态记录；留给下次启动的对账，绝不提前写 succeeded。
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ taskKey: "run-1", state: "running", result: { mediaState: "materializing" } });
    expect(h.records.some((record) => record.state === "succeeded")).toBe(false);
    expect(h.logs.map((event) => event.event)).toContain("runtime-shutdown-materialization-timeout");
  });
});
