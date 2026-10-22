/**
 * Task Service 媒体操作（change: split-web-runtime-services，任务 3.5 / 4.5）。
 *
 * 用真实 HTTP 组装 Media Service + Task Service（假 worker 不发 provider 调用），验证：
 * - 参考输入由 Task 通过 Media `sign` 换成短期 HTTPS 地址后才进入 provider input；
 * - 签名 URL 不进入历史 read model（不落 prompt/URL/bytes）；
 * - Media 签名失败在调用 provider 之前失败，不产生 accepted 执行；
 * - 输入校验走 Media `verify`：不存在的对象在 provider 之前拒绝。
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMediaService } from "@woohaa3/media-service";
import { createTaskService } from "@woohaa3/task-service";

/** 与 MediaStorage 的 not-found 错误同形（避免 tooling 依赖 media-storage 实现包）。 */
class MediaObjectNotFoundError extends Error {
  readonly code = "MEDIA_OBJECT_NOT_FOUND";
  constructor(key: string) {
    super(`Media object not found: ${key}`);
    this.name = "MediaObjectNotFoundError";
  }
}
import type { PptaskWorkerServer } from "@sdppp/pptask-worker-server";

const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-task-media-"));
  dirs.push(dir);
  return path.join(dir, name);
}

function listen(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    void handler(req, res)
      .then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      })
      .catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

const CHECKSUM = "d".repeat(64);
const STORAGE_KEY = `sha256-${CHECKSUM}`;

type SubmitInput = {
  key: string;
  modelType: string;
  modelId: string;
  input: Record<string, unknown>;
};

function capturingWorkerServer(captured: SubmitInput[]): PptaskWorkerServer {
  const listeners = new Set<(record: unknown) => void>();
  return {
    worker: {} as never,
    async submit(input: never) {
      captured.push(input as SubmitInput);
      return { record: { id: (input as SubmitInput).key, status: "queued" }, created: true } as never;
    },
    async status() {
      return null;
    },
    async cancel() {},
    history: {
      get: async () => undefined,
      list: async () => [],
      subscribe(listener: never) {
        listeners.add(listener as never);
        return () => listeners.delete(listener as never);
      },
      ingestSchedulingEvent() {},
      async flush() {},
      async dispose() {}
    } as never,
    subscribe(listener: never) {
      listeners.add(listener as never);
      return () => listeners.delete(listener as never);
    },
    /** 测试驱动：模拟 worker 产生一条终态 execution record。 */
    emit(record: unknown) {
      for (const listener of listeners) listener(record);
    },
    stop() {},
    async drained() {},
    async close() {}
  } as unknown as PptaskWorkerServer;
}

const PROVIDER_IMAGE_BYTES = Uint8Array.from([1, 2, 3, 4]);

async function startCluster(
  options: {
    signFails?: boolean;
    objectExists?: boolean;
    mediaImportFault?: boolean;
    providerImageUrl?: string;
  } = {}
) {
  const canvasToken = "canvas-token";
  const taskToken = "task-token";
  const exists = options.objectExists ?? true;

  const mediaService = createMediaService({
    // provider 输出 URL 的受控下载：注入 DNS 与 fetch，避免真实出网。
    resolveHost: async () => ["93.184.216.34"],
    fetchImpl: (async (url: string | URL) => {
      const stringUrl = String(url);
      if (options.mediaImportFault || stringUrl.includes("broken.invalid")) {
        return new Response("nope", { status: 500 });
      }
      return new Response(PROVIDER_IMAGE_BYTES, {
        status: 200,
        headers: { "content-type": "image/png" }
      });
    }) as unknown as typeof globalThis.fetch,
    storage: {
      async put() {},
      async get() {
        throw new Error("unused");
      },
      async exists() {
        return exists;
      },
      async stat(key: string) {
        if (!exists) throw new MediaObjectNotFoundError(key);
        return { size: 4, contentType: "image/png" };
      },
      async getHttpsUrl(key: string, opts?: { expiresSeconds?: number }) {
        if (options.signFails) throw new Error("COS signing unavailable");
        void opts;
        return `https://cos.invalid/${key}?sign=secret-signature`;
      }
    } as never,
    identities: { tokens: { "canvas-service": canvasToken, "task-service": taskToken } }
  });
  const media = await listen(mediaService.handle);
  closers.push(async () => {
    await mediaService.close();
    await new Promise<void>((r) => media.server.close(() => r()));
  });

  const captured: SubmitInput[] = [];
  const worker = capturingWorkerServer(captured) as PptaskWorkerServer & { emit: (record: unknown) => void };
  const taskService = createTaskService({
    env: {
      WOOHAA3_TASK_STORE_PATH: tempDb("task.sqlite"),
      PPTASK_LITELLM_API_KEY: "placeholder",
      PPTASK_LITELLM_BASE_URL: "https://litellm.invalid"
    },
    modelsConfig: { version: 1, models: [{ id: "fake:fake-image", default: true }] },
    serviceToken: taskToken,
    mediaServiceUrl: `http://127.0.0.1:${media.port}`,
    workerServer: worker,
    generationProviders: () => [{
      extensionId: "test-generation",
      providerId: "fake",
      available: true,
      provider: {},
      models: [{
        providerId: "fake",
        providerModelId: "fake-image",
        modelType: "image",
        title: "Fake Image",
        inputSchema: { type: "object", properties: { prompt: { type: "string" }, urls: { type: "array", maxItems: 4, "x-pptask-semantic": "reference-image" } } },
        defaultInput: {}
      }]
    }]
  });
  const task = await listen(taskService.handle);
  closers.push(async () => {
    await taskService.close();
    await new Promise<void>((r) => task.server.close(() => r()));
  });

  return { task, media, taskToken, captured, worker };
}

function submitBody(inputs: Array<{ assetId: string; role: string; storageKey: string; mediaType: string }>) {
  return {
    workerTaskKey: "worker-1",
    canvasId: "c1",
    nodeId: "n1",
    runId: "run-1",
    jobId: "job-1",
    nodeType: "image",
    modelType: "image",
    modelKey: "fake:fake-image",
    prompt: "draw",
    parameters: {},
    inputs
  };
}

describe("Task 输入媒体签名（任务 3.5 / 4.5）", () => {
  it("参考输入经 Media sign 换成 HTTPS URL 后才进入 provider input", async () => {
    const { task, taskToken, captured } = await startCluster();
    const response = await fetch(`http://127.0.0.1:${task.port}/internal/v1/tasks/worker-1`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": taskToken, "x-woohaa3-protocol-version": "1" },
      body: JSON.stringify(
        submitBody([{ assetId: "a1", role: "reference_image", storageKey: STORAGE_KEY, mediaType: "image/png" }])
      )
    });
    if (response.status !== 202) throw new Error(`submit ${response.status}: ${await response.text()}`);
    expect(captured).toHaveLength(1);
    const urls = (captured[0]!.input as { urls?: string[] }).urls;
    expect(urls).toEqual([`https://cos.invalid/${STORAGE_KEY}?sign=secret-signature`]);
  });

  it("签名 URL 不进入历史 read model（不落 URL / bytes / prompt）", async () => {
    const { task, taskToken } = await startCluster();
    await fetch(`http://127.0.0.1:${task.port}/internal/v1/tasks/worker-1`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": taskToken, "x-woohaa3-protocol-version": "1" },
      body: JSON.stringify(
        submitBody([{ assetId: "a1", role: "reference_image", storageKey: STORAGE_KEY, mediaType: "image/png" }])
      )
    });
    const history = await (
      await fetch(`http://127.0.0.1:${task.port}/internal/v1/task-history?after=0`, {
        headers: { "x-woohaa3-service-token": taskToken, "x-woohaa3-protocol-version": "1" }
      })
    ).text();
    expect(history).not.toContain("secret-signature");
    expect(history).not.toContain("cos.invalid");
    expect(history).not.toContain("draw");
  });

  it("Media 签名失败：在调用 provider 之前失败，captured 为空", async () => {
    const { task, taskToken, captured } = await startCluster({ signFails: true });
    const response = await fetch(`http://127.0.0.1:${task.port}/internal/v1/tasks/worker-1`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": taskToken, "x-woohaa3-protocol-version": "1" },
      body: JSON.stringify(
        submitBody([{ assetId: "a1", role: "reference_image", storageKey: STORAGE_KEY, mediaType: "image/png" }])
      )
    });
    expect(response.status).toBe(502);
    expect(captured).toHaveLength(0);
  });

  it("参考对象不存在：verify 在 provider 之前拒绝", async () => {
    const { task, taskToken, captured } = await startCluster({ objectExists: false });
    const response = await fetch(`http://127.0.0.1:${task.port}/internal/v1/tasks/worker-1`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": taskToken, "x-woohaa3-protocol-version": "1" },
      body: JSON.stringify(
        submitBody([{ assetId: "a1", role: "reference_image", storageKey: STORAGE_KEY, mediaType: "image/png" }])
      )
    });
    expect(response.status).toBe(400);
    expect(captured).toHaveLength(0);
  });

  it("无参考输入时不调用 sign（captured input 无 urls）", async () => {
    const { task, taskToken, captured } = await startCluster();
    const response = await fetch(`http://127.0.0.1:${task.port}/internal/v1/tasks/worker-1`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": taskToken, "x-woohaa3-protocol-version": "1" },
      body: JSON.stringify(submitBody([]))
    });
    expect(response.status).toBe(202);
    expect(captured).toHaveLength(1);
    expect((captured[0]!.input as { urls?: unknown }).urls).toBeUndefined();
  });
});

/** 轮询直到记录达到目标状态（并行跑测试时定时器会被延迟）。 */
async function waitForState(
  task: { port: number },
  taskToken: string,
  taskKey: string,
  states: string[]
): Promise<{ state?: string; result?: { storageKey?: string; mediaKind?: string; text?: string }; error?: { message?: string } }> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const detail = (await (
      await fetch(`http://127.0.0.1:${task.port}/internal/v1/tasks/${taskKey}`, {
        headers: { "x-woohaa3-service-token": taskToken, "x-woohaa3-protocol-version": "1" }
      })
    ).json()) as { state?: string };
    if (detail.state && states.includes(detail.state)) return detail as never;
    if (Date.now() > deadline) return detail as never;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("Task provider 图片输出转存（任务 4.5）", () => {
  const IMAGE_URL = "https://provider.invalid/out.png";

  function succeededRecord(taskKey: string, url = IMAGE_URL) {
    const now = new Date().toISOString();
    return {
      id: taskKey,
      providerId: "fake",
      modelType: "image" as const,
      state: "succeeded" as const,
      result: { outputs: [{ kind: "image" as const, url }] },
      events: [],
      createdAt: now,
      updatedAt: now,
      finishedAt: now,
      durationMs: 1
    };
  }

  /** 触发懒加载 runtime（其订阅在首次 submit 时建立），之后才能 emit。 */
  async function ensureRuntime(task: { port: number }, taskToken: string) {
    await fetch(`http://127.0.0.1:${task.port}/internal/v1/tasks/runtime-warmup`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": taskToken, "x-woohaa3-protocol-version": "1" },
      body: JSON.stringify({
        workerTaskKey: "runtime-warmup",
        canvasId: "c",
        nodeId: "n",
        runId: "runtime-warmup",
        jobId: "j",
        nodeType: "image",
        modelType: "image",
        modelKey: "fake:fake-image",
        prompt: "warmup",
        parameters: {},
        inputs: []
      })
    });
  }

  it("provider 图片输出先经 Media import 再落 succeeded + 稳定 storageKey", async () => {
    const { task, taskToken, worker } = await startCluster();
    await ensureRuntime(task, taskToken);
    worker.emit(succeededRecord("run-img"));
    const detail = await waitForState(task, taskToken, "run-img", ["succeeded", "failed"]);
    expect(detail.state).toBe("succeeded");
    expect(detail.result).toMatchObject({ mediaKind: "image" });
    expect(detail.result?.storageKey).toMatch(/^generation-outputs\/[0-9a-f]{64}\.png$/);
    // 不落 provider 原始 URL。
    expect(JSON.stringify(detail)).not.toContain("provider.invalid");
  });

  it("Media import 失败：不写 succeeded，记录为 failed", async () => {
    const { task, taskToken, worker } = await startCluster();
    await ensureRuntime(task, taskToken);
    worker.emit(succeededRecord("run-broken", "https://broken.invalid/out.png"));
    const detail = await waitForState(task, taskToken, "run-broken", ["succeeded", "failed"]);
    expect(detail.state).toBe("failed");
    expect(detail.result?.storageKey).toBeUndefined();
    expect(detail.error?.message).toContain("转存");
  });

  it("succeeded 后紧接的重复终态广播不会覆盖图片结果（settle 竞态回归）", async () => {
    // 回归：worker 在 provider 返回后会先广播 succeeded、稍后再广播一次 scheduling
    // `task-completed`（state 同样 succeeded）。若第二次落进普通投影路径，会先写一条
    // 「无资产」终态，projector 的 commandId 与真实图片结果相同 → 被判 duplicate，资产丢失。
    const { task, taskToken, worker } = await startCluster();
    await ensureRuntime(task, taskToken);
    worker.emit(succeededRecord("run-race"));
    // 立刻再发一条无结果输出的 succeeded（模拟 scheduling 终态重播）。
    const now = new Date().toISOString();
    worker.emit({
      id: "run-race",
      providerId: "fake",
      state: "succeeded",
      events: [],
      createdAt: now,
      updatedAt: now,
      finishedAt: now,
      durationMs: 1
    });
    const detail = await waitForState(task, taskToken, "run-race", ["succeeded", "failed"]);
    expect(detail.state).toBe("succeeded");
    // 结果必须保留稳定的图片 metadata，不能被后来的空终态覆盖。
    expect(detail.result?.storageKey).toMatch(/^generation-outputs\/[0-9a-f]{64}\.png$/);
  });

  it("文本输出不经 Media import，直接落 succeeded", async () => {
    const { task, taskToken, worker } = await startCluster();
    await ensureRuntime(task, taskToken);
    const now = new Date().toISOString();
    worker.emit({
      id: "run-text",
      providerId: "fake",
      state: "succeeded",
      result: { outputs: [{ kind: "text", text: "你好" }] },
      events: [],
      createdAt: now,
      updatedAt: now,
      finishedAt: now,
      durationMs: 1
    });
    const detail = await waitForState(task, taskToken, "run-text", ["succeeded", "failed"]);
    expect(detail.state).toBe("succeeded");
    expect(detail.result).toMatchObject({ mediaKind: "text", text: "你好" });
  });
});
