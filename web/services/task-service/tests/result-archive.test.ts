/**
 * 落库前归档：provider 字节 → Media 稳定对象，`task_records` 里只留引用。
 *
 * 回归（2026-10-28）：dev 库 2.2GB / 92 行，单张 6.99MB 图片被 JSON 展开成 93.6MB 存两份
 * （`state.record.result` + `result`）。这里钉住四条不变式：
 * 1. 同一份字节只 import 一次，state / result 都换成 `{ media }`；
 * 2. 转存失败原样保留字节（宁可大，不可丢）；
 * 3. SQLite 列里不再出现 `{"0":...}` 展开，落库后是 KB 级；
 * 4. 已归档的记录由 materializer 按引用 verify-and-adopt，不再 importBytes。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { PptaskTaskRecord, PptaskTaskStore } from "@sdppp/pptask-worker-server";
import type { ExecutionRecord } from "@sdppp/pptask-worker-server/history";
import type { MediaMetadata } from "@woohaa3/contracts";
import type { MediaClient } from "../src/clients/media-client.js";
import { createSqliteTaskStore } from "../src/repository/sqlite-task-store.js";
import { loadNodeSqlite } from "../src/repository/sqlite-loader.js";
import type { SqliteTaskHistoryRepository } from "../src/repository/history-repository.js";
import { createResultArchiver } from "../src/worker/result-archive.js";
import { materializeBinaryBytesFromStore } from "../src/worker/media-materialization.js";

const IMAGE_KEY = `generation-outputs/${"a".repeat(64)}.png`;
const CHECKSUM = "a".repeat(64);

const dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-task-archive-"));
  dirs.push(dir);
  return path.join(dir, "task.sqlite");
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function mediaMetadata(size = 8): MediaMetadata {
  return { storageKey: IMAGE_KEY, contentType: "image/png", size, checksum: CHECKSUM, mediaKind: "image" };
}

function makeClient(options: { fail?: boolean } = {}) {
  const imports: Array<Record<string, unknown>> = [];
  const client = {
    verify: async () => ({ exists: true, matches: true, metadata: mediaMetadata() }),
    sign: async () => "https://cos.example/signed",
    importFromUrl: async () => mediaMetadata(),
    importBytes: async (input: Record<string, unknown>) => {
      imports.push(input);
      if (options.fail) throw new Error("storage down");
      const bytesBase64 = String(input.bytesBase64 ?? "");
      return mediaMetadata(Buffer.from(bytesBase64, "base64").byteLength);
    }
  } as unknown as MediaClient;
  return { client, imports };
}

function record(overrides: Partial<PptaskTaskRecord> = {}): PptaskTaskRecord {
  return {
    key: "run-1",
    providerId: "tokenhub",
    params: { modelType: "image", modelId: "hy-image" },
    context: { canvasId: "canvas-1", nodeId: "node-1" },
    status: "executing",
    attempt: 1,
    consecutiveFailures: 0,
    createdAt: new Date(1000),
    updatedAt: new Date(2000),
    ...overrides
  };
}

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

describe("落库前归档（result-archive）", () => {
  it("state 与 result 携带同一份字节时只 import 一次，两处都换成稳定引用", async () => {
    const { client, imports } = makeClient();
    const archive = createResultArchiver({ mediaClient: client });
    const providerMetadata = { tokenhub: { images: [{ mediaType: "image/png" }] } };
    // 两份字节是「内容相同、对象不同」的两份拷贝：job repository 每次 get 都会 clone。
    const payload = record({
      result: { images: [PNG], providerMetadata },
      state: {
        jobId: "job-1",
        record: { id: "job-1", state: "succeeded", result: { images: [new Uint8Array(PNG)], providerMetadata } }
      }
    });

    const archived = await archive(payload);

    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ contentType: "image/png", canvasId: "canvas-1" });
    expect(Buffer.from(String(imports[0].bytesBase64), "base64")).toEqual(Buffer.from(PNG));

    expect(archived?.result).toMatchObject({
      media: { storageKey: IMAGE_KEY, contentType: "image/png", size: 8, checksum: CHECKSUM },
      providerMetadata
    });
    expect((archived?.result as Record<string, unknown>).images).toBeUndefined();
    const stateRecord = (archived?.state as { record: { result: Record<string, unknown> } }).record;
    expect(stateRecord.result).toMatchObject({ media: { storageKey: IMAGE_KEY } });

    // 入参不被就地修改：worker 的内存快照还要用原始记录恢复。
    expect((payload.result as { images: unknown[] }).images).toEqual([PNG]);
  });

  it("转存失败保留原始字节并记日志（宁可大，不可丢）", async () => {
    const { client } = makeClient({ fail: true });
    const logs: Array<Record<string, unknown>> = [];
    const archive = createResultArchiver({ mediaClient: client, logger: (event) => logs.push(event) });
    const payload = record({ result: { images: [PNG] } });

    const archived = await archive(payload);

    expect(archived).toBeUndefined();
    expect((payload.result as { images: unknown[] }).images).toEqual([PNG]);
    expect(logs.map((event) => event.event)).toContain("task-result-archive-failed");
  });

  it("文本 / 已归档 / 视频字节都不触发 import", async () => {
    const { client, imports } = makeClient();
    const archive = createResultArchiver({ mediaClient: client });

    expect(await archive(record({ result: { text: "hello" } }))).toBeUndefined();
    expect(
      await archive(record({ result: { media: { storageKey: IMAGE_KEY, contentType: "image/png", size: 8 } } }))
    ).toBeUndefined();
    expect(await archive(record({ params: { modelType: "video" }, result: { videos: [PNG] } }))).toBeUndefined();
    expect(imports).toHaveLength(0);
  });

  it("Media 返回非稳定键时保留原始字节（不留半成品引用）", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const client = {
      verify: async () => ({ exists: true, matches: true }),
      sign: async () => "https://cos.example/signed",
      importFromUrl: async () => mediaMetadata(),
      importBytes: async () => ({ storageKey: "not-a-key", contentType: "image/png", size: 8 })
    } as unknown as MediaClient;
    const archive = createResultArchiver({ mediaClient: client, logger: (event) => logs.push(event) });
    const payload = record({ result: { images: [PNG] } });

    expect(await archive(payload)).toBeUndefined();
    expect((payload.result as { images: unknown[] }).images).toEqual([PNG]);
    expect(logs.map((event) => event.event)).toContain("task-result-archive-failed");
  });

  it("多产物结果不归档（不静默丢弃第二份产物）", async () => {
    const { client, imports } = makeClient();
    const archive = createResultArchiver({ mediaClient: client });
    expect(await archive(record({ result: { images: [PNG, new Uint8Array([1, 2, 3])] } }))).toBeUndefined();
    expect(imports).toHaveLength(0);
  });
});

describe("SQLite 落库边界", () => {
  it("按 worker 的两次 save 落库：只 import 一次，state_json / result_json 都是 KB 级", async () => {
    const { client, imports } = makeClient();
    const file = tempDb();
    const store = createSqliteTaskStore({
      path: file,
      transformPayload: createResultArchiver({ mediaClient: client })
    });
    await store.submit({
      key: "run-1",
      providerId: "tokenhub",
      params: { modelType: "image" },
      context: { canvasId: "canvas-1" },
      now: new Date(1000)
    });
    const claimed = (await store.claimDue({ now: new Date(2000), leaseUntil: new Date(9000) }))!;
    const bytes = new Uint8Array(512 * 1024).fill(7);

    // worker 的真实写序：先把引擎快照（含 result）落一次，再单独落 task result。
    // 两次是不同对象（job repository 会 clone），但内容相同 → 只应 import 一次。
    await store.save({
      ...claimed,
      state: { jobId: "job-1", record: { id: "job-1", state: "succeeded", result: { images: [bytes] } } }
    });
    await store.save({
      ...claimed,
      result: { images: [new Uint8Array(bytes)], providerMetadata: { tokenhub: { images: [{ mediaType: "image/png" }] } } },
      state: { jobId: "job-1", record: { id: "job-1", state: "succeeded", result: { images: [bytes] } } }
    });
    expect(imports).toHaveLength(1);

    const saved = await store.find("run-1");
    expect(saved?.result).toMatchObject({ media: { storageKey: IMAGE_KEY } });
    expect((saved?.state as { record: { result: unknown } }).record.result).toMatchObject({
      media: { storageKey: IMAGE_KEY }
    });
    store.close();

    // 直接看列长度：修复前 0.5MB 字节会被展开成 6MB 以上，并且 state/result 各一份。
    const { DatabaseSync } = loadNodeSqlite();
    const db = new DatabaseSync(file);
    const row = db
      .prepare("SELECT length(state_json) AS s, length(result_json) AS r FROM task_records WHERE key = ?")
      .get("run-1") as { s: number; r: number };
    db.close();
    expect(row.r).toBeLessThan(4096);
    expect(row.s).toBeLessThan(4096);
  });

  it("变换抛错时按原值落库（瘦身不能阻断持久化）", async () => {
    const store = createSqliteTaskStore({
      path: tempDb(),
      transformPayload: async () => {
        throw new Error("archiver bug");
      }
    });
    await store.submit({ key: "k", providerId: "litellm", now: new Date(1000) });
    const claimed = (await store.claimDue({ now: new Date(2000), leaseUntil: new Date(9000) }))!;
    await store.save({ ...claimed, result: { images: [PNG] } });
    const saved = await store.find("k");
    // 字节经 JSON 往返后是索引对象，但内容仍在：不因归档失败丢结果。
    expect(Object.keys((saved?.result as { images: Array<Record<string, unknown>> }).images[0])).toContain("0");
    store.close();
  });

  it("归档窗口内被 cancel：落库不覆盖已取消状态（围栏必须原子）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = createSqliteTaskStore({
      path: tempDb(),
      transformPayload: async (payload) => {
        // submit 阶段没有 state/result，不要挡住它；只卡住带结果的落库。
        if (payload.result !== undefined || payload.state !== undefined) await gate;
        return undefined;
      }
    });
    await store.submit({ key: "k", providerId: "litellm", now: new Date(1000) });
    const claimed = (await store.claimDue({ now: new Date(2000), leaseUntil: new Date(9000) }))!;

    const saving = store.save({ ...claimed, status: "completed", result: { images: [PNG] } });
    // 归档（转存）还没回来时用户取消：claimToken 被换掉，这次 save 必须失效。
    await store.cancel("k", new Date(3000));
    release();
    await saving;

    expect((await store.find("k"))?.status).toBe("cancelled");
    store.close();
  });
});

describe("归档记录的消费端", () => {
  it("materializer 按稳定引用 adopt，不再 importBytes", async () => {
    const { client, imports } = makeClient();
    const historyUpserts: Array<Record<string, unknown>> = [];
    const history = {
      upsertRecord: (input: Record<string, unknown>) => {
        historyUpserts.push(input);
        return 1;
      },
      lastEventTail: () => undefined,
      lastEvent: () => undefined,
      appendEvent: () => 1
    } as unknown as SqliteTaskHistoryRepository;
    const taskStore = {
      find: async (key: string) => ({
        key,
        providerId: "tokenhub",
        status: "completed" as const,
        attempt: 1,
        consecutiveFailures: 0,
        createdAt: new Date(1000),
        updatedAt: new Date(2000),
        result: { media: { storageKey: IMAGE_KEY, contentType: "image/png", size: 8, checksum: CHECKSUM } }
      })
    } as unknown as PptaskTaskStore;
    const execution: ExecutionRecord = {
      id: "run-1",
      providerId: "tokenhub",
      modelType: "image",
      state: "succeeded",
      events: [],
      createdAt: "2026-10-28T05:00:00.000Z",
      updatedAt: "2026-10-28T05:00:10.000Z",
      durationMs: 10_000
    };

    await materializeBinaryBytesFromStore(
      { taskStore, history, mediaClient: client },
      execution,
      { canvasId: "canvas-1", nodeId: "node-1", runId: "run-1", jobId: "job-1" },
      "image"
    );

    expect(imports).toHaveLength(0);
    expect(historyUpserts.at(-1)).toMatchObject({
      state: "succeeded",
      result: { mediaKind: "image", storageKey: IMAGE_KEY }
    });
  });
});
