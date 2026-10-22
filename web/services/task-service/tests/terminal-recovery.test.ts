/**
 * 重启后的终态对账（修复：重启落在「provider 已成功、结果转存 Media + 写 history」窗口）。
 *
 * 覆盖：
 * 1. 调度侧 completed、history 仍 running → 用 durable 字节重新转存并补写 succeeded；
 * 2. 只有 provider 受控地址时回退 URL 转存（视频带海报/时长）；
 * 3. 调度侧 failed/cancelled → 补写对应终态与可读原因；
 * 4. 仍在执行 / 没有调度记录 / 已被其它路径推进 → 一律跳过；
 * 5. 二进制结果无法转存（无 bytes、无 URL、无 Media）→ 落 failed，绝不落无产物的 succeeded；
 * 6. 文本任务的终态补写。
 */
import { describe, expect, it } from "vitest";
import type { PptaskTaskRecord, PptaskTaskStore } from "@sdppp/pptask-worker-server";
import type { MediaClient } from "../src/clients/media-client.js";
import type { SqliteTaskHistoryRepository } from "../src/repository/history-repository.js";
import { recoverTerminalHistory, TERMINAL_RECOVERY_EVENT_STAGE } from "../src/worker/terminal-recovery.js";
import type { TaskExecutionState, TaskExecutionSummary } from "@woohaa3/contracts";

const IMAGE_KEY = `generation-outputs/${"e".repeat(64)}.png`;
const VIDEO_KEY = `generation-outputs/${"c".repeat(64)}.mp4`;
const POSTER_KEY = `generation-outputs/${"d".repeat(64)}.png`;

function metadataFor(storageKey: string, kind: "image" | "video" | "audio") {
  const checksum = storageKey.slice("generation-outputs/".length, "generation-outputs/".length + 64);
  return {
    storageKey,
    contentType: kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mpeg" : "image/png",
    size: 3,
    checksum,
    mediaKind: kind
  };
}

function candidate(overrides: Partial<TaskExecutionSummary> = {}): TaskExecutionSummary {
  return {
    taskKey: "run-1",
    state: "running",
    providerId: "tokenhub",
    modelType: "image",
    canvasId: "canvas-1",
    nodeId: "node-1",
    runId: "run-1",
    createdAt: "2026-10-20T10:57:52.202Z",
    updatedAt: "2026-10-20T10:57:52.232Z",
    durationMs: 0,
    recordRevision: 3,
    ...overrides
  };
}

function taskRecord(overrides: Partial<PptaskTaskRecord> = {}): PptaskTaskRecord {
  return {
    key: "run-1",
    providerId: "tokenhub",
    params: { providerId: "tokenhub", modelType: "image", modelId: "hy-image-v3.5-preview", input: {} },
    context: { canvasId: "canvas-1", nodeId: "node-1", runId: "run-1", jobId: "job-run-1" },
    result: { images: [new Uint8Array([1, 2, 3])] },
    status: "completed",
    attempt: 1,
    consecutiveFailures: 0,
    createdAt: new Date("2026-10-20T10:57:52.202Z"),
    updatedAt: new Date("2026-10-20T10:58:16.126Z"),
    ...overrides
  };
}

type ImportCall = { kind: "url" | "bytes"; input: Record<string, unknown> };

function fakeMedia() {
  const imports: ImportCall[] = [];
  const client = {
    async verify() {
      return { exists: true, matches: true };
    },
    async sign() {
      return "https://cos.example/signed";
    },
    async importFromUrl(input: Record<string, unknown>) {
      imports.push({ kind: "url", input });
      const url = String(input.url);
      if (url.includes("poster")) return metadataFor(POSTER_KEY, "image");
      return url.endsWith(".mp4") ? metadataFor(VIDEO_KEY, "video") : metadataFor(IMAGE_KEY, "image");
    },
    async importBytes(input: Record<string, unknown>) {
      imports.push({ kind: "bytes", input });
      return metadataFor(IMAGE_KEY, "image");
    }
  };
  return { client: client as unknown as MediaClient, imports };
}

function harness(options: {
  candidates: TaskExecutionSummary[];
  tasks: PptaskTaskRecord[];
  media?: ReturnType<typeof fakeMedia>;
  historyState?: (taskKey: string) => TaskExecutionState | undefined;
  includeMedia?: boolean;
}) {
  const histories: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const logs: Array<Record<string, unknown>> = [];
  const currentStates = new Map(options.candidates.map((item) => [item.taskKey, item.state]));
  const history = {
    listUnsettled: (limit?: number) => options.candidates.slice(0, limit ?? 200),
    stateOf: (taskKey: string) => options.historyState?.(taskKey) ?? currentStates.get(taskKey),
    upsertRecord: (input: Record<string, unknown>) => {
      histories.push(input);
      currentStates.set(String(input.taskKey), input.state as TaskExecutionState);
      return 1;
    },
    lastEventTail: () => undefined,
    lastEvent: () => undefined,
    appendEvent: (input: Record<string, unknown>) => {
      events.push(input);
      return 1;
    }
  } as unknown as SqliteTaskHistoryRepository;
  const byKey = new Map(options.tasks.map((task) => [task.key, task]));
  const taskStore = {
    async find(key: string) {
      return byKey.get(key) ?? null;
    }
  } as unknown as PptaskTaskStore;
  const media = options.media ?? fakeMedia();
  return {
    options: {
      taskStore,
      history,
      ...(options.includeMedia === false ? {} : { mediaClient: media.client }),
      logger: (event: Record<string, unknown>) => logs.push(event)
    },
    histories,
    events,
    logs,
    imports: media.imports
  };
}

describe("recoverTerminalHistory", () => {
  it("completed + history running：从 durable 字节重新转存并补写 succeeded", async () => {
    const h = harness({ candidates: [candidate()], tasks: [taskRecord()] });
    const summary = await recoverTerminalHistory(h.options);

    expect(summary).toMatchObject({ scanned: 1, recovered: 1, skipped: 0, failed: 0 });
    expect(h.imports).toHaveLength(1);
    expect(h.imports[0]).toMatchObject({
      kind: "bytes",
      input: { bytesBase64: "AQID", contentType: "image/png", canvasId: "canvas-1" }
    });
    expect(h.histories).toHaveLength(1);
    expect(h.histories[0]).toMatchObject({
      taskKey: "run-1",
      state: "succeeded",
      canvasId: "canvas-1",
      nodeId: "node-1",
      runId: "run-1",
      finishedAt: "2026-10-20T10:58:16.126Z",
      result: { mediaKind: "image", storageKey: IMAGE_KEY, checksum: "e".repeat(64) }
    });
    // 时间线补一条可追溯的「重启后补记」。
    expect(h.events.map((event) => event.stage)).toEqual([TERMINAL_RECOVERY_EVENT_STAGE]);
  });

  it("只有 provider 受控地址时回退 URL 转存", async () => {
    const raw = { providerMetadata: { tokenhub: { images: [{ url: "https://cos.example/a.png?sign=1" }] } } };
    const h = harness({ candidates: [candidate()], tasks: [taskRecord({ result: raw })] });
    await recoverTerminalHistory(h.options);

    expect(h.imports).toHaveLength(1);
    expect(h.imports[0]).toMatchObject({ kind: "url", input: { url: "https://cos.example/a.png?sign=1", canvasId: "canvas-1" } });
    expect(h.histories[0]).toMatchObject({ state: "succeeded", result: { mediaKind: "image" } });
  });

  it("视频只用地址，并带回海报与时长", async () => {
    const raw = {
      videos: [{ url: "https://provider.example/out.mp4" }],
      posterUrl: "https://provider.example/poster.png",
      durationSeconds: 8
    };
    const h = harness({
      candidates: [candidate({ modelType: "video" })],
      tasks: [taskRecord({ params: { modelType: "video", modelId: "seedance" }, result: raw })]
    });
    await recoverTerminalHistory(h.options);

    expect(h.imports.map((call) => call.kind)).toEqual(["url", "url"]);
    expect(h.imports[0].input).toMatchObject({ url: "https://provider.example/out.mp4", canvasId: "canvas-1" });
    expect(h.imports[1].input).toMatchObject({ url: "https://provider.example/poster.png" });
    expect(h.histories[0]).toMatchObject({
      state: "succeeded",
      result: { mediaKind: "video", durationSeconds: 8, poster: { storageKey: POSTER_KEY } }
    });
  });

  it("调度侧 failed：补写 failed 并给出可读原因", async () => {
    const h = harness({
      candidates: [candidate()],
      tasks: [taskRecord({ status: "failed", result: undefined })]
    });
    const summary = await recoverTerminalHistory(h.options);

    expect(summary.recovered).toBe(1);
    expect(h.imports).toHaveLength(0);
    expect(h.histories[0]).toMatchObject({ state: "failed", error: { name: "TerminalProjectionLost" } });
    expect(String((h.histories[0].error as { message?: string }).message)).toContain("进程重启中断");
  });

  it("调度侧 cancelled：补写 cancelled", async () => {
    const h = harness({
      candidates: [candidate()],
      tasks: [taskRecord({ status: "cancelled", result: undefined })]
    });
    await recoverTerminalHistory(h.options);

    expect(h.histories[0]).toMatchObject({ state: "cancelled" });
    expect(h.imports).toHaveLength(0);
  });

  it("文本任务按原始结果补写 succeeded", async () => {
    const raw = { content: [{ type: "text", text: "hello" }] };
    const h = harness({
      candidates: [candidate({ modelType: "language" })],
      tasks: [taskRecord({ params: { modelType: "language", modelId: "gpt" }, result: raw })]
    });
    await recoverTerminalHistory(h.options);

    expect(h.imports).toHaveLength(0);
    expect(h.histories[0]).toMatchObject({ state: "succeeded", result: { mediaKind: "text", text: "hello" } });
  });

  it("未配置 Media 时与运行期一致按原样投影（不伪造资产）", async () => {
    const h = harness({
      candidates: [candidate()],
      tasks: [taskRecord({ result: {} })],
      includeMedia: false
    });
    await recoverTerminalHistory(h.options);

    expect(h.histories[0]).toMatchObject({ state: "succeeded" });
    expect(h.histories[0].error).toBeUndefined();
    expect(h.histories[0].result).toBeUndefined();
  });

  it("没有可转存来源（无 bytes、无地址）时也落 failed", async () => {
    const h = harness({ candidates: [candidate()], tasks: [taskRecord({ result: { images: [] } })] });
    await recoverTerminalHistory(h.options);

    expect(h.imports).toHaveLength(0);
    expect(h.histories[0]).toMatchObject({ state: "failed", error: { name: "MediaRecoveryError" } });
  });

  it("仍在执行中的调度记录不碰（交给 lease 接管）", async () => {
    const h = harness({
      candidates: [candidate()],
      tasks: [taskRecord({ status: "executing", result: undefined })]
    });
    const summary = await recoverTerminalHistory(h.options);

    expect(summary).toMatchObject({ scanned: 1, recovered: 0, skipped: 1 });
    expect(h.histories).toHaveLength(0);
  });

  it("调度 store 没有记录（提交前失败）不碰，交给孤儿对账", async () => {
    const h = harness({ candidates: [candidate()], tasks: [] });
    const summary = await recoverTerminalHistory(h.options);

    expect(summary).toMatchObject({ scanned: 1, recovered: 0, skipped: 1 });
    expect(h.histories).toHaveLength(0);
  });

  it("已被其它路径推进过（history 状态变化）不覆盖", async () => {
    const h = harness({
      candidates: [candidate()],
      tasks: [taskRecord()],
      historyState: () => "succeeded"
    });
    const summary = await recoverTerminalHistory(h.options);

    expect(summary).toMatchObject({ scanned: 1, recovered: 0, skipped: 1 });
    expect(h.histories).toHaveLength(0);
    expect(h.imports).toHaveLength(0);
  });

  it("按 modelType 缺省时从原始结果推断二进制类型", async () => {
    const h = harness({
      candidates: [candidate({ modelType: undefined })],
      tasks: [taskRecord({ params: {}, result: { images: [new Uint8Array([9, 9])] } })]
    });
    await recoverTerminalHistory(h.options);

    expect(h.imports[0]).toMatchObject({ kind: "bytes" });
    expect(h.histories[0]).toMatchObject({ state: "succeeded", result: { mediaKind: "image" } });
  });
});
