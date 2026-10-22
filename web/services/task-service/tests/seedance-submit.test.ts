/**
 * Seedance 视频提交闭环回归
 * （修复：素材库未部署时参考图永久 queued 的真实缺陷）。
 *
 * 覆盖两条真实缺陷路径：
 * 1. `asset://` 素材库是**可选**能力：未注入 materializer 时，图片参考必须回落到 Media
 *    签发的短期 HTTPS URL，并在未配置时把任务真正调度出去（不再永远停在 queued）。
 * 2. 调度前失败后的重试：submit 幂等 claim 先于调度写入，若之前调度失败，命中 reused
 *    时必须**重新调度**，而不是直接返回 `queued` 把任务永久卡住。
 *
 * 通过**真实内部 HTTP 协议**驱动（复用 composition 的 handle），只把 Media client 与
 * worker server 替换成假实现，避免真实凭据与上游网络。
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createTaskService, type TaskService } from "../src/composition.js";
import type { GenerationProvider } from "@woohaa3/contracts";
import { createSqliteTaskHistoryRepository } from "../src/repository/history-repository.js";
import type { ModelsConfig } from "../src/config/models-config.js";

const MODELS: ModelsConfig = { version: 1, models: [] };
const UPSTREAM = "ep-20260101000000-seedance";
const TOKEN = "test-token";
const dirs: string[] = [];

function tempStore(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-video-"));
  dirs.push(dir);
  return path.join(dir, "task.sqlite");
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** 假的 Media client：签名返回短期 HTTPS 地址，verify 恒通过。 */
function fakeMediaClient() {
  const client = {
    async verify() {
      return { exists: true, matches: true };
    },
    async sign(storageKey: string) {
      return `https://cos.example/${storageKey}?signature=test`;
    },
    async importFromUrl() {
      throw new Error("no output import in this test");
    },
    async importBytes() {
      throw new Error("no output import in this test");
    }
  };
  return { client };
}

/** 捕获 worker 实际收到的 provider 输入，避免真实调用 Ark。 */
function recordingWorkerServer() {
  const submitted: Array<Record<string, unknown>> = [];
  const server = {
    async submit(input: { key: string; input: unknown }) {
      submitted.push(input.input as Record<string, unknown>);
      return {
        created: true,
        record: { key: input.key, providerId: "ark", status: "queued", attempt: 0 }
      };
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
  return { submitted, server };
}

const VIDEO_REQUEST = {
  workerTaskKey: "run-video-1",
  canvasId: "canvas-1",
  nodeId: "video-1",
  runId: "run-video-1",
  jobId: "job-run-video-1",
  nodeType: "video",
  modelType: "video",
  modelKey: "ark:seedance2_5",
  prompt: "角色在大路上蹦蹦跳跳",
  parameters: { generationMode: "omni_reference", durationSeconds: 5 },
  inputs: [
    {
      assetId: "asset-image-1",
      role: "reference_image",
      storageKey: `generation-outputs/${"f".repeat(64)}.png`,
      mediaType: "image/png",
      mediaKind: "image"
    }
  ]
};

type Harness = {
  service: TaskService;
  base: string;
  close: () => Promise<void>;
};

async function startService(options: {
  storePath: string;
  workerServer: unknown;
  ensureVideoImageAsset?: (input: unknown) => Promise<{ assetId: string; uri: string; status: string }>;
}): Promise<Harness> {
  const media = fakeMediaClient();
  const ark: GenerationProvider = {
    extensionId: "ark-provider",
    providerId: "ark",
    available: true,
    provider: {} as never,
    models: [{ providerId: "ark", providerModelId: "seedance2_5", modelType: "video" as const }],
    describeModel: async ({ providerModelId }) => ({
      providerId: "ark",
      modelId: providerModelId,
      modelType: "video",
      title: providerModelId,
      inputSchema: {
        type: "object",
        required: ["prompt"],
        properties: {
          prompt: { type: "string", title: "提示词" },
          urls: { type: "array", title: "参考图", "x-pptask-semantic": "reference-image", maxItems: 15 },
          videoUrls: { type: "array", title: "参考视频", "x-pptask-semantic": "reference-video", maxItems: 15 },
          audioUrls: { type: "array", title: "参考音频", "x-pptask-semantic": "reference-audio", maxItems: 15 }
        }
      },
      defaultInput: {}
    }) as never
  };
  const service = createTaskService({
    modelsConfig: MODELS,
    storePath: options.storePath,
    env: {
      LITELLM_API_KEY: "k",
      LITELLM_BASE_URL: "https://llm.example/v1",
      WOOHAA3_TASK_STORE_PATH: options.storePath
    },
    generationProviders: () => [ark],
    mediaClient: media.client as never,
    workerServer: options.workerServer as never,
    serviceToken: TOKEN,
    ...(options.ensureVideoImageAsset
      ? { ensureVideoImageAsset: options.ensureVideoImageAsset as never }
      : {})
  });

  const server = http.createServer((req, res) => {
    void service.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    service,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await service.close();
    }
  };
}

async function submit(base: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}/internal/v1/tasks/${(body as { workerTaskKey: string }).workerTaskKey}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-woohaa3-service-token": TOKEN,
      "x-woohaa3-protocol-version": "1"
    },
    body: JSON.stringify(body)
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe("Seedance 图片参考回落到签名 HTTPS URL", () => {
  it("未配置素材库：图片参考用短期 HTTPS 地址，任务被真正调度", async () => {
    const worker = recordingWorkerServer();
    const harness = await startService({ storePath: tempStore(), workerServer: worker.server });
    try {
      const result = await submit(harness.base, VIDEO_REQUEST);
      expect(result.status).toBe(202);
      expect(worker.submitted).toHaveLength(1);
      // Ark payload 的图片参考是签名的 HTTPS 地址，而不是 asset://。
      const urls = worker.submitted[0]!.urls as Array<{ url: string }>;
      expect(urls[0]!.url).toContain("https://cos.example/");
    } finally {
      await harness.close();
    }
  });

  it("配置素材库：图片参考被替换成 asset:// 引用", async () => {
    const worker = recordingWorkerServer();
    const harness = await startService({
      storePath: tempStore(),
      workerServer: worker.server,
      ensureVideoImageAsset: async () => ({ assetId: "asset-abc", uri: "asset://asset-abc", status: "Active" })
    });
    // materializer 会读取签名 URL 的图片字节；这里只替换图片读取，协议请求仍走真实 fetch。
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://cos.example/")) {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { "content-type": "image/png" }
        });
      }
      return realFetch(input as never, init);
    }) as typeof globalThis.fetch;
    try {
      const result = await submit(harness.base, VIDEO_REQUEST);
      expect(result.status).toBe(202);
      const urls = worker.submitted[0]!.urls as Array<{ url: string }>;
      expect(urls[0]!.url).toBe("asset://asset-abc");
    } finally {
      globalThis.fetch = realFetch;
      await harness.close();
    }
  });
});

describe("submit 幂等命中但未调度时重新调度", () => {
  it("调度前失败后的同 key 重试不再返回假 queued", async () => {
    const storePath = tempStore();

    // 第一次：worker 在调度前抛错（对应真实的 502 之后客户端重试场景）。
    const failing = await startService({
      storePath,
      workerServer: {
        async submit() {
          throw new Error("worker down");
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
      }
    });
    try {
      const failed = await submit(failing.base, VIDEO_REQUEST);
      expect(failed.status).toBe(500);
      expect(await failing.service.taskStore().find("run-video-1")).toBeNull();
    } finally {
      await failing.close();
    }

    // 第二次：同 key 同 payload，必须重新调度（旧实现直接返回 queued 且永不调度）。
    const worker = recordingWorkerServer();
    const retry = await startService({ storePath, workerServer: worker.server });
    try {
      const result = await submit(retry.base, VIDEO_REQUEST);
      expect(result.status).toBe(202);
      // 调度确实到达 worker（不再永久 queued）。
      expect(worker.submitted).toHaveLength(1);
    } finally {
      await retry.close();
    }
  });
});

describe("孤儿提交对账", () => {
  it("listUnsettledBefore 只返回过期非终态；settleOrphanFailure 落 failed 并推进 cursor", () => {
    const repo = createSqliteTaskHistoryRepository({ path: tempStore() });
    repo.upsertRecord({
      taskKey: "orphan",
      state: "queued",
      providerId: "ark",
      canvasId: "c1",
      nodeId: "v1",
      runId: "orphan",
      createdAt: "2020-01-01T00:00:00Z",
      updatedAt: "2020-01-01T00:00:00Z",
      durationMs: 0
    });
    repo.upsertRecord({
      taskKey: "recent",
      state: "queued",
      providerId: "ark",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      durationMs: 0
    });
    repo.upsertRecord({
      taskKey: "done",
      state: "succeeded",
      providerId: "ark",
      createdAt: "2020-01-01T00:00:00Z",
      updatedAt: "2020-01-01T00:00:00Z",
      durationMs: 0
    });

    const cutoff = new Date(Date.now() - 60_000).toISOString();
    expect(repo.listUnsettledBefore(cutoff).map((r) => r.taskKey)).toEqual(["orphan"]);

    const before = repo.currentCursor();
    expect(repo.settleOrphanFailure("orphan", { message: "未调度", updatedAt: new Date().toISOString() })).toBe(true);
    expect(repo.currentCursor()).toBeGreaterThan(before);
    expect(repo.get("orphan")?.state).toBe("failed");
    expect(repo.get("orphan")?.error?.message).toBe("未调度");

    // 终态不可被孤儿对账改写（幂等）。
    expect(repo.settleOrphanFailure("done", { message: "x", updatedAt: new Date().toISOString() })).toBe(false);
    expect(repo.get("done")?.state).toBe("succeeded");
    repo.close();
  });

  it("启动对账把「非终态 + 调度表无记录」的过期记录落成 failed", async () => {
    const storePath = tempStore();
    const seed = createSqliteTaskHistoryRepository({ path: storePath });
    seed.upsertRecord({
      taskKey: "run-orphan",
      state: "queued",
      providerId: "ark",
      modelType: "video",
      modelKey: "ark:seedance2_5",
      canvasId: "canvas-1",
      nodeId: "video-1",
      runId: "run-orphan",
      createdAt: "2020-01-01T00:00:00Z",
      updatedAt: "2020-01-01T00:00:00Z",
      durationMs: 0
    });
    seed.close();

    const worker = recordingWorkerServer();
    const harness = await startService({ storePath, workerServer: worker.server });
    try {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && harness.service.history().get("run-orphan")?.state !== "failed") {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(harness.service.history().get("run-orphan")?.state).toBe("failed");
      // 对账不应触发任何新的 provider 调度。
      expect(worker.submitted).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});
