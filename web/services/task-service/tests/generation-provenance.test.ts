/**
 * L0 生成溯源：参考输入身份、上游任务号、结构化错误与完整事件时间线
 * （change: l0-generation-provenance）。
 *
 * 覆盖四件从「画布产物」反查「原始调用」必须成立的事实：
 * 1. 提交时的稳定引用（assetId/storageKey/role/mediaType）进入 history 详情，执行期签名 URL 绝不入库；
 * 2. execution record 的 `taskId`（上游 Provider 任务号）投影成 `upstreamTaskId`；
 * 3. 事件时间线增量追加，重复投影不产生重复事件；
 * 4. 错误保留结构化 status/code，而不是只剩一句拼接字符串。
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { GenerationProvider } from "@woohaa3/contracts";
import { createTaskService, type TaskService } from "../src/composition.js";
import type { ModelsConfig } from "../src/config/models-config.js";
import { SqliteTaskHistoryRepository } from "../src/repository/history-repository.js";
import { loadNodeSqlite } from "../src/repository/sqlite-loader.js";
import { sanitizeError } from "../src/repository/history/sanitization.js";
import { projectExecutionRecord } from "../src/worker/execution-projection.js";

const MODELS: ModelsConfig = { version: 1, models: [] };
const TOKEN = "test-token";
const dirs: string[] = [];

function tempStore(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-provenance-"));
  dirs.push(dir);
  return path.join(dir, "task.sqlite");
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const REFERENCE_KEY = `generation-outputs/${"b".repeat(64)}.png`;

const REQUEST = {
  workerTaskKey: "run-provenance-1",
  canvasId: "canvas-1",
  nodeId: "image-1",
  runId: "run-provenance-1",
  jobId: "job-run-provenance-1",
  nodeType: "image",
  modelType: "image",
  modelKey: "tracer:model-1",
  prompt: "一只猫",
  parameters: { size: "1024x1024" },
  inputs: [
    {
      assetId: "asset-image-1",
      role: "reference_image",
      storageKey: REFERENCE_KEY,
      mediaType: "image/png",
      mediaKind: "image"
    }
  ]
};

function providerWithUpload(uploadReference: GenerationProvider["uploadReference"]): GenerationProvider {
  return {
    extensionId: "tracer-provider",
    providerId: "tracer",
    available: true,
    provider: {} as never,
    models: [
      {
        providerId: "tracer",
        providerModelId: "model-1",
        modelType: "image",
        inputSchema: {
          type: "object",
          required: ["prompt"],
          properties: {
            prompt: { type: "string", title: "提示词" },
            urls: { type: "array", title: "参考图", "x-pptask-semantic": "reference-image", maxItems: 15 }
          }
        },
        defaultInput: {}
      }
    ],
    ...(uploadReference ? { uploadReference } : {})
  };
}

function recordingMediaClient() {
  const signed: string[] = [];
  return {
    signed,
    client: {
      async verify() {
        return { exists: true, matches: true };
      },
      async sign(storageKey: string) {
        signed.push(storageKey);
        return `https://cos.example/${storageKey}?signature=test`;
      },
      async importFromUrl() {
        throw new Error("no output import in this test");
      },
      async importBytes() {
        throw new Error("no output import in this test");
      }
    }
  };
}

function recordingWorkerServer() {
  const server = {
    async submit(input: { key: string }) {
      return { created: true, record: { key: input.key, providerId: "tracer", status: "queued", attempt: 0 } };
    },
    async cancel() {},
    async status() {
      return null;
    },
    history: { subscribe: () => () => undefined },
    subscribe: () => () => undefined,
    stop() {},
    async drained() {},
    async close() {}
  };
  return { server };
}

async function startService(provider: GenerationProvider): Promise<{
  base: string;
  close: () => Promise<void>;
}> {
  const media = recordingMediaClient();
  const worker = recordingWorkerServer();
  const service: TaskService = createTaskService({
    modelsConfig: MODELS,
    storePath: tempStore(),
    env: { WOOHAA3_TASK_STORE_PATH: tempStore() },
    generationProviders: () => [provider],
    mediaClient: media.client as never,
    workerServer: worker.server as never,
    serviceToken: TOKEN
  });
  const server = http.createServer((req, res) => {
    void service.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await service.close();
    }
  };
}

async function submit(base: string, workerTaskKey = REQUEST.workerTaskKey): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}/internal/v1/tasks/${workerTaskKey}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-woohaa3-service-token": TOKEN,
      "x-woohaa3-protocol-version": "1"
    },
    body: JSON.stringify({ ...REQUEST, workerTaskKey, runId: workerTaskKey, jobId: `job-${workerTaskKey}` })
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

type Detail = {
  request?: { prompt: string; parameters: Record<string, unknown>; inputs?: Array<Record<string, unknown>> };
  upstreamTaskId?: string;
  events?: Array<{ stage: string }>;
};

describe("L0 溯源：参考输入身份入历史", () => {
  it("提交时的稳定引用进入详情，且不带执行期签名 URL", async () => {
    const harness = await startService(
      providerWithUpload(() => "https://uploader.example/ref-1")
    );
    try {
      const submission = await submit(harness.base);
      expect(submission.status, JSON.stringify(submission.body)).toBe(202);

      const response = await fetch(`${harness.base}/api/pptask/history/${REQUEST.workerTaskKey}`);
      expect(response.status).toBe(200);
      const detail = (await response.json()) as Detail;

      expect(detail.request?.inputs).toEqual([
        {
          role: "reference_image",
          mediaKind: "image",
          mediaType: "image/png",
          assetId: "asset-image-1",
          storageKey: REFERENCE_KEY
        }
      ]);
      // 溯源只留稳定身份：任何执行期签出地址都不该出现在历史里。
      expect(JSON.stringify(detail)).not.toContain("signature=");
      expect(JSON.stringify(detail)).not.toContain("https://uploader.example");
    } finally {
      await harness.close();
    }
  });
});

describe("L0 溯源：上游任务号与事件时间线", () => {
  it("execution record 的 taskId 投影为 upstreamTaskId", () => {
    const repo = new SqliteTaskHistoryRepository({ path: tempStore() });
    try {
      projectExecutionRecord(repo, {
        id: "run-upstream-1",
        providerId: "tracer",
        modelType: "video",
        state: "running",
        taskId: "upstream-task-42",
        events: [{ at: "2026-10-20T00:00:00.000Z", stage: "accepted", kind: "execution" }],
        createdAt: "2026-10-20T00:00:00.000Z",
        updatedAt: "2026-10-20T00:00:01.000Z",
        durationMs: 1000
      } as never);
      expect(repo.get("run-upstream-1")?.upstreamTaskId).toBe("upstream-task-42");
    } finally {
      repo.close();
    }
  });

  it("事件按时刻增量追加，重复投影同一快照不产生重复事件", () => {
    const repo = new SqliteTaskHistoryRepository({ path: tempStore() });
    try {
      const base = {
        id: "run-events-1",
        providerId: "tracer",
        modelType: "image" as const,
        state: "running" as const,
        createdAt: "2026-10-20T00:00:00.000Z",
        durationMs: 0
      };
      const first = {
        ...base,
        events: [
          { at: "2026-10-20T00:00:01.000Z", stage: "submitting", kind: "execution" as const },
          { at: "2026-10-20T00:00:02.000Z", stage: "accepted", kind: "execution" as const }
        ],
        updatedAt: "2026-10-20T00:00:02.000Z"
      };
      projectExecutionRecord(repo, first as never);
      expect(repo.get("run-events-1")?.events.map((event) => event.stage)).toEqual(["submitting", "accepted"]);

      // 同一快照重复投影（worker 会反复收到累计 record）：不得重复落事件。
      projectExecutionRecord(repo, first as never);
      expect(repo.get("run-events-1")?.events).toHaveLength(2);

      // 出现新事件后只追加新增的那条。
      projectExecutionRecord(
        repo,
        {
          ...first,
          events: [
            ...first.events,
            { at: "2026-10-20T00:00:03.000Z", stage: "provider.started", kind: "execution" as const }
          ],
          updatedAt: "2026-10-20T00:00:03.000Z"
        } as never
      );
      expect(repo.get("run-events-1")?.events.map((event) => event.stage)).toEqual([
        "submitting",
        "accepted",
        "provider.started"
      ]);
    } finally {
      repo.close();
    }
  });
});

describe("L0 溯源：同一毫秒内的连续状态变化", () => {
  it("同一时刻的多条事件按条数补齐，不丢也不重复", () => {
    const repo = new SqliteTaskHistoryRepository({ path: tempStore() });
    try {
      const sameAt = "2026-10-20T00:00:05.000Z";
      const record = {
        id: "run-same-ms-1",
        providerId: "tracer",
        modelType: "image" as const,
        state: "running" as const,
        createdAt: sameAt,
        durationMs: 0,
        events: [
          { at: sameAt, stage: "created", kind: "execution" as const },
          { at: sameAt, stage: "submitting", kind: "execution" as const }
        ],
        updatedAt: sameAt
      };
      projectExecutionRecord(repo, record as never);
      expect(repo.get("run-same-ms-1")?.events.map((event) => event.stage)).toEqual(["created", "submitting"]);

      // 同一快照重复投影：两条都已落库，不再追加。
      projectExecutionRecord(repo, record as never);
      expect(repo.get("run-same-ms-1")?.events).toHaveLength(2);

      // 同一毫秒内新增第三条：只补这一条。
      projectExecutionRecord(
        repo,
        {
          ...record,
          events: [...record.events, { at: sameAt, stage: "accepted", kind: "execution" as const }]
        } as never
      );
      expect(repo.get("run-same-ms-1")?.events.map((event) => event.stage)).toEqual([
        "created",
        "submitting",
        "accepted"
      ]);
    } finally {
      repo.close();
    }
  });
});

describe("L0 溯源：上游任务号回填", () => {
  it("老历史记录从 worker 调度库回填 upstreamTaskId，且重复打开不覆盖已有值", () => {
    const { DatabaseSync } = loadNodeSqlite();
    const storePath = tempStore();
    // 先让 repository 建好历史表，并写入一条「新列还没出现时」的历史记录。
    const first = new SqliteTaskHistoryRepository({ path: storePath });
    first.upsertRecord({
      taskKey: "run-legacy-1",
      state: "succeeded",
      providerId: "ark",
      modelType: "video",
      createdAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:30.000Z",
      finishedAt: "2026-10-20T00:00:30.000Z",
      durationMs: 30_000
    });
    expect(first.get("run-legacy-1")?.upstreamTaskId).toBeUndefined();
    first.close();

    // worker 调度库同库存着上游任务号（异步 Provider 的 operation.taskId）。
    const raw = new DatabaseSync(storePath);
    raw.exec(`CREATE TABLE IF NOT EXISTS task_records (
      key TEXT PRIMARY KEY, provider_id TEXT, params_json TEXT, context_json TEXT,
      state_json TEXT, result_json TEXT, owner_id TEXT, status TEXT, claim_token TEXT,
      lease_until INTEGER, next_run_at INTEGER, attempt INTEGER, consecutive_failures INTEGER,
      created_at TEXT, updated_at TEXT)`);
    raw
      .prepare("INSERT INTO task_records (key, provider_id, state_json, status) VALUES (?, ?, ?, ?)")
      .run(
        "run-legacy-1",
        "ark",
        JSON.stringify({ jobId: "job-1", record: { operation: { taskId: "cgt-legacy-42" } } }),
        "completed"
      );
    raw.close();

    // 再次打开：迁移期回填。
    const reopened = new SqliteTaskHistoryRepository({ path: storePath });
    expect(reopened.get("run-legacy-1")?.upstreamTaskId).toBe("cgt-legacy-42");
    // 结果/状态等既有字段不被回填影响。
    expect(reopened.get("run-legacy-1")?.state).toBe("succeeded");
    reopened.close();
  });
});

describe("L0 溯源：进度事件限流", () => {
  it("连续同一进度阶段按 10s 限流，状态迁移一条不丢", () => {
    const repo = new SqliteTaskHistoryRepository({ path: tempStore() });
    try {
      const at = (seconds: number) => new Date(Date.UTC(2026, 9, 20, 0, 0, seconds)).toISOString();
      const base = {
        id: "run-throttle-1",
        providerId: "tracer",
        modelType: "image" as const,
        state: "succeeded" as const,
        createdAt: at(0),
        durationMs: 13_000,
        updatedAt: at(13),
        events: [
          { at: at(0), stage: "pptask.created", kind: "execution" as const },
          { at: at(1), stage: "pptask.progress", kind: "execution" as const },
          { at: at(2), stage: "pptask.progress", kind: "execution" as const },
          { at: at(3), stage: "pptask.progress", kind: "execution" as const },
          { at: at(11), stage: "pptask.progress", kind: "execution" as const },
          { at: at(12), stage: "pptask.progress", kind: "execution" as const },
          { at: at(13), stage: "pptask.succeeded", kind: "execution" as const }
        ]
      };
      projectExecutionRecord(repo, base as never);
      // 1s 处保留；2s/3s 距上次不足 10s 跳过；11s 保留；12s 跳过；迁移全保留。
      expect(repo.get("run-throttle-1")?.events.map((event) => event.stage)).toEqual([
        "pptask.created",
        "pptask.progress",
        "pptask.progress",
        "pptask.succeeded"
      ]);
      // 重复投影同一快照不新增事件。
      projectExecutionRecord(repo, base as never);
      expect(repo.get("run-throttle-1")?.events).toHaveLength(4);
    } finally {
      repo.close();
    }
  });
});

describe("L0 溯源：结构化错误", () => {
  it("保留 status 与上游 code，仍然截断 message 且丢弃其他字段", () => {
    const sanitized = sanitizeError({
      name: "ProviderHttpError",
      message: "x".repeat(900),
      status: 429,
      code: "RateLimitExceeded",
      // 调用方即便传了这些，也不能被写进历史。
      stack: "at foo",
      headers: { authorization: "Bearer secret" },
      body: "{}"
    } as never);
    expect(sanitized).toEqual({
      name: "ProviderHttpError",
      message: "x".repeat(500),
      status: 429,
      code: "RateLimitExceeded"
    });
  });

  it("缺失 status/code 时不伪造字段", () => {
    expect(sanitizeError({ message: "boom" })).toEqual({ message: "boom" });
  });
});
