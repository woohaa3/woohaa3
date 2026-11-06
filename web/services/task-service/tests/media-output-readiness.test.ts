/**
 * 媒体输出就绪回归（change: 2026-11-06-fix-media-output-readiness，任务 1.1 / 3.1 / 3.2）。
 *
 * 现场 N04：任务先写 succeeded，媒体 2 秒后才导入，窗口内预览/下载 404。
 * 现场 N13：provider 视频 URL 已 404，任务失败但没有可诊断的 HTTP 状态。
 *
 * 这里用可控制的转存 Promise 复现同一时间窗：转存完成前 history 只能看到 running +
 * mediaState=materializing，绝不出现 succeeded；转存失败则落 failed 并保留安全状态码。
 */
import { describe, expect, it } from "vitest";
import type { PptaskTaskRecord, PptaskTaskStore, PptaskWorkerServer } from "@sdppp/pptask-worker-server";
import type { ExecutionRecord } from "@sdppp/pptask-worker-server/history";
import type { MediaMetadata, TaskExecutionState, TaskModelType, TaskResultSummary } from "@woohaa3/contracts";
import { taskMediaReadiness } from "@woohaa3/contracts";
import type { MediaClient } from "../src/clients/media-client.js";
import type { SqliteTaskHistoryRepository } from "../src/repository/history-repository.js";
import { createTaskRuntime } from "../src/worker/runtime.js";

const IMAGE_KEY = `generation-outputs/${"a".repeat(64)}.png`;
const VIDEO_KEY = `generation-outputs/${"b".repeat(64)}.mp4`;
const PROVIDER_URL = "https://provider.example/temporary/out.mp4?signature=secret";

function metadataFor(storageKey: string, mediaKind: MediaMetadata["mediaKind"]): MediaMetadata {
  const checksum = storageKey.slice("generation-outputs/".length, "generation-outputs/".length + 64);
  return {
    storageKey,
    contentType: mediaKind === "video" ? "video/mp4" : "image/png",
    size: 10,
    checksum,
    mediaKind
  };
}

function record(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: "run-readiness",
    providerId: "agnes-video",
    modelType: "video",
    state: "succeeded",
    result: {
      outputCount: 1,
      outputs: [{ kind: "video", url: PROVIDER_URL }],
      value: {}
    },
    events: [],
    createdAt: "2026-11-06T00:07:30.000Z",
    updatedAt: "2026-11-06T00:07:33.517Z",
    finishedAt: "2026-11-06T00:07:33.517Z",
    durationMs: 3_517,
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness(options: { importFromUrl: (input: { url: string }) => Promise<MediaMetadata> }) {
  const records: Array<Record<string, unknown>> = [];
  const logs: Array<Record<string, unknown>> = [];
  const history = {
    upsertRecord: (input: Record<string, unknown>) => {
      records.push(input);
      return records.length;
    },
    appendEvent: () => 1,
    lastEventTail: () => undefined,
    lastEvent: () => undefined,
    stateOf: () => "running"
  } as unknown as SqliteTaskHistoryRepository;
  const mediaClient = {
    async verify() {
      return { exists: true, matches: true, metadata: metadataFor(VIDEO_KEY, "video") };
    },
    async sign() {
      return "https://cos.example/signed";
    },
    importFromUrl: options.importFromUrl,
    async importBytes() {
      return metadataFor(VIDEO_KEY, "video");
    }
  } as unknown as MediaClient;
  const taskStore = {
    find: async (key: string) =>
      ({
        key,
        providerId: "agnes-video",
        status: "completed",
        attempt: 1,
        consecutiveFailures: 0,
        context: { canvasId: "canvas-1", nodeId: "node-1", runId: "run-readiness", jobId: "job-1" },
        createdAt: new Date("2026-11-06T00:07:30.000Z"),
        updatedAt: new Date("2026-11-06T00:07:33.517Z")
      }) as unknown as PptaskTaskRecord
  } as unknown as PptaskTaskStore;

  let listener: ((record: ExecutionRecord) => void) | undefined;
  const server = {
    submit: async () => ({ created: true }),
    cancel: async () => undefined,
    status: async () => null,
    history: { subscribe: () => () => undefined },
    subscribe: (fn: (record: ExecutionRecord) => void) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    stop: () => undefined,
    drained: async () => undefined,
    abortAll: () => undefined,
    close: async () => undefined
  } as unknown as PptaskWorkerServer;

  return {
    records,
    logs,
    emit: (execution: ExecutionRecord = record()) => listener?.(execution),
    create: () =>
      createTaskRuntime({
        taskStore,
        history,
        provider: {} as never,
        providerId: "agnes-video",
        mediaClient,
        server,
        shutdownGraceMs: 5_000,
        logger: (event) => logs.push(event as unknown as Record<string, unknown>)
      })
  };
}

describe("N04：媒体转存完成前不可见 succeeded", () => {
  it("先投影 running + mediaState=materializing，导入成功后才写 succeeded", async () => {
    const download = deferred<MediaMetadata>();
    const h = harness({ importFromUrl: () => download.promise });
    const runtime = await h.create();
    h.emit();
    await Promise.resolve();

    // 转存未完成：history 只有准备态，成功入口不可用。
    expect(h.records.some((entry) => entry.state === "succeeded")).toBe(false);
    expect(h.records.at(-1)).toMatchObject({
      taskKey: "run-readiness",
      state: "running",
      result: { mediaKind: "video", mediaState: "materializing" }
    });
    expect(h.records.at(-1)).not.toHaveProperty("finishedAt");
    expect(h.logs.map((event) => event.event)).toContain("media-output-materializing");
    // 同一份历史记录交给浏览器后派生为「准备中」：活动项/节点入口不会把它当成功媒体。
    const preparing = h.records.at(-1)! as {
      state: TaskExecutionState;
      modelType?: TaskModelType;
      result?: TaskResultSummary;
    };
    expect(taskMediaReadiness(preparing)).toBe("preparing");

    download.resolve(metadataFor(VIDEO_KEY, "video"));
    await runtime.close();

    expect(h.records.at(-1)).toMatchObject({
      taskKey: "run-readiness",
      state: "succeeded",
      result: { mediaKind: "video", storageKey: VIDEO_KEY }
    });
  });
});

describe("N13：provider 视频 URL 失效", () => {
  it("落 failed 并保留安全 HTTP 状态，不产生空视频资产、不泄漏临时 URL", async () => {
    const h = harness({
      importFromUrl: () =>
        Promise.reject(Object.assign(new Error(`受控下载失败 ${PROVIDER_URL}`), {
          code: "media-not-found",
          status: 404
        }))
    });
    const runtime = await h.create();
    h.emit();
    await runtime.close();

    const last = h.records.at(-1)!;
    expect(last).toMatchObject({
      taskKey: "run-readiness",
      state: "failed",
      error: { name: "MediaImportError", status: 404, code: "media-not-found" }
    });
    expect(JSON.stringify(last.error)).toContain("HTTP 404");
    expect(last.result).toEqual({ mediaKind: "video" });
    expect(JSON.stringify(h.records)).not.toContain("provider.example");
    expect(JSON.stringify(h.logs)).not.toContain("provider.example");
  });

  it("状态码与稳定 code 通过 history 白名单保留", async () => {
    const h = harness({
      importFromUrl: () =>
        Promise.reject(Object.assign(new Error("temporary"), { code: "provider-rejected", status: 403 }))
    });
    const runtime = await h.create();
    h.emit();
    await runtime.close();
    expect(h.records.at(-1)).toMatchObject({
      state: "failed",
      error: { status: 403, code: "provider-rejected" }
    });
  });
});
