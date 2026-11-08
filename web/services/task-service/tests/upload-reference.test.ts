/**
 * 参考输入「Provider 自带上传优先」回归（设计稿：storage-extension-point 的生成链路）。
 *
 * ① Provider 有 `uploadReference` 且宿主能读出参考字节 → 用它返回的地址，不调存储签名；
 * ② 未实现、返回空、抛错 → 回落到 Media 的 `sign`（存储 expose 签出地址）；
 * ③ 宿主没有提供字节读取能力 → 直接走 ②。
 *
 * 经真实内部 HTTP 协议驱动（复用 composition 的 handle），只把 Media client、worker server
 * 与字节读取替换成假实现，不碰真实存储与上游网络。
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { GenerationProvider } from "@woohaa3/contracts";
import { createTaskService, type TaskService } from "../src/composition.js";
import type { ModelsConfig } from "../src/config/models-config.js";

const MODELS: ModelsConfig = { version: 1, models: [] };
const TOKEN = "test-token";
const dirs: string[] = [];

function tempStore(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-upload-ref-"));
  dirs.push(dir);
  return path.join(dir, "task.sqlite");
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** 记录的 Media client：只关心 sign 是否被调用。 */
function recordingMediaClient() {
  const signed: string[] = [];
  return {
    signed,
    client: {
      async verify() {
        return { exists: true, matches: true };
      },
      async sign(storageKey: string, _ttl?: number, scope?: { canvasId: string }) {
        // 该对象只存在于远端画布；无作用域时默认存储无法提供它。
        if (scope?.canvasId !== REQUEST.canvasId) throw new Error("reference not found in primary storage");
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
  const submitted: Array<Record<string, unknown>> = [];
  const server = {
    async submit(input: { key: string; input: unknown }) {
      submitted.push(input.input as Record<string, unknown>);
      return { created: true, record: { key: input.key, providerId: "uploader", status: "queued", attempt: 0 } };
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

/** 受控对象键：`generation-outputs/<64 位 sha256>.<ext>`。 */
const REFERENCE_KEY = `generation-outputs/${"a".repeat(64)}.png`;

const REQUEST = {
  workerTaskKey: "run-upload-1",
  canvasId: "canvas-1",
  nodeId: "image-1",
  runId: "run-upload-1",
  jobId: "job-run-upload-1",
  nodeType: "image",
  modelType: "image",
  modelKey: "uploader:model-1",
  prompt: "一只猫",
  parameters: {},
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
    extensionId: "uploader-provider",
    providerId: "uploader",
    available: true,
    provider: {} as never,
    models: [
      {
        providerId: "uploader",
        providerModelId: "model-1",
        modelType: "image",
        // 声明参考图绑定，与 Ark 图片模型的 `urls`（reference-image）同形。
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

type Harness = { base: string; close: () => Promise<void> };

async function startService(options: {
  provider: GenerationProvider;
  readReferenceObject?: (storageKey: string, scope?: { canvasId: string }) => Promise<{ bytes: Uint8Array; contentType?: string }>;
  logger?: (event: Record<string, unknown>) => void;
}): Promise<{ harness: Harness; media: ReturnType<typeof recordingMediaClient>; worker: ReturnType<typeof recordingWorkerServer>; service: TaskService }> {
  const media = recordingMediaClient();
  const worker = recordingWorkerServer();
  const service: TaskService = createTaskService({
    modelsConfig: MODELS,
    storePath: tempStore(),
    env: { WOOHAA3_TASK_STORE_PATH: tempStore() },
    generationProviders: () => [options.provider],
    mediaClient: media.client as never,
    workerServer: worker.server as never,
    serviceToken: TOKEN,
    ...(options.readReferenceObject ? { readReferenceObject: options.readReferenceObject } : {}),
    ...(options.logger ? { logger: options.logger } : {})
  });
  const server = http.createServer((req, res) => {
    void service.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    media,
    worker,
    service,
    harness: {
      base: `http://127.0.0.1:${port}`,
      close: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await service.close();
      }
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
    body: JSON.stringify({ ...REQUEST, workerTaskKey, runId: workerTaskKey, jobId: workerTaskKey })
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

describe("参考输入：Provider 自带上传优先", () => {
  it("Provider 上传成功时用它的地址，且不调存储签名", async () => {
    const seen: Array<{ storageKey: string; bytes: number[]; contentType: string }> = [];
    const { harness, media, worker } = await startService({
      provider: providerWithUpload((input) => {
        seen.push({ storageKey: REQUEST.inputs[0]!.storageKey, bytes: [...input.bytes], contentType: input.contentType });
        return { url: "https://uploader.example/ref-1" };
      }),
      readReferenceObject: async (storageKey, scope) => {
        expect(storageKey).toBe(REFERENCE_KEY);
        expect(scope).toEqual({ canvasId: REQUEST.canvasId });
        return { bytes: Uint8Array.of(7, 7), contentType: "image/png" };
      }
    });
    try {
      const submission = await submit(harness.base);
      expect(submission.status, JSON.stringify(submission.body)).toBe(202);
      expect(seen).toEqual([
        { storageKey: REFERENCE_KEY, bytes: [7, 7], contentType: "image/png" }
      ]);
      expect(worker.submitted[0]!.urls).toEqual(["https://uploader.example/ref-1"]);
      expect(media.signed).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("返回空地址时回落到存储签名", async () => {
    const { harness, media, worker } = await startService({
      provider: providerWithUpload(() => undefined),
      readReferenceObject: async () => ({ bytes: Uint8Array.of(1), contentType: "image/png" })
    });
    try {
      const submission = await submit(harness.base);
      expect(submission.status, JSON.stringify(submission.body)).toBe(202);
      expect(worker.submitted[0]!.urls).toEqual([`https://cos.example/${REFERENCE_KEY}?signature=test`]);
      expect(media.signed).toEqual([REFERENCE_KEY]);
    } finally {
      await harness.close();
    }
  });

  it("上传抛错时记日志并回落到存储签名，不阻断提交", async () => {
    const events: Array<Record<string, unknown>> = [];
    const { harness, media, worker } = await startService({
      provider: providerWithUpload(() => {
        throw new Error("uploader down");
      }),
      readReferenceObject: async () => ({ bytes: Uint8Array.of(1), contentType: "image/png" }),
      logger: (event) => events.push(event)
    });
    try {
      const submission = await submit(harness.base);
      expect(submission.status, JSON.stringify(submission.body)).toBe(202);
      expect(events.find((event) => event.event === "task-upload-reference-failed")).toMatchObject({
        providerId: "uploader",
        message: "uploader down"
      });
      expect(worker.submitted[0]!.urls).toEqual([`https://cos.example/${REFERENCE_KEY}?signature=test`]);
      expect(media.signed).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("没有字节读取能力时完全不问 Provider，直接签名", async () => {
    let called = 0;
    const { harness, media, worker } = await startService({
      provider: providerWithUpload(() => {
        called += 1;
        return { url: "https://uploader.example/ref-1" };
      })
    });
    try {
      const submission = await submit(harness.base);
      expect(submission.status, JSON.stringify(submission.body)).toBe(202);
      expect(called).toBe(0);
      expect(worker.submitted[0]!.urls).toEqual([`https://cos.example/${REFERENCE_KEY}?signature=test`]);
      expect(media.signed).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("执行期地址只在提交前解析，规范资产与长期历史不保存签名 URL；重试重新解析", async () => {
    const { harness, media, worker, service } = await startService({
      provider: providerWithUpload(undefined),
      readReferenceObject: async () => ({ bytes: Uint8Array.of(1), contentType: "image/png" })
    });
    try {
      const first = await submit(harness.base, "run-upload-retry-1");
      expect(first.status, JSON.stringify(first.body)).toBe(202);
      expect(worker.submitted[0]!.urls).toEqual([`https://cos.example/${REFERENCE_KEY}?signature=test`]);
      const record = service.history().get("run-upload-retry-1", { fullText: true, includeRequest: true });
      expect(JSON.stringify(record)).not.toContain("signature=test");
      expect((record?.request as { inputs?: Array<{ storageKey?: string }> } | undefined)?.inputs?.[0]?.storageKey).toBe(REFERENCE_KEY);

      // 队列恢复/提交重试是新的地址准备：真正交给远端前重新解析，不沿用旧签名。
      const retry = await submit(harness.base, "run-upload-retry-2");
      expect(retry.status, JSON.stringify(retry.body)).toBe(202);
      expect(worker.submitted[1]!.urls).toEqual([`https://cos.example/${REFERENCE_KEY}?signature=test`]);
      expect(media.signed).toEqual([REFERENCE_KEY, REFERENCE_KEY]);
    } finally {
      await harness.close();
    }
  });

  it("Provider 没有 uploadReference 时走存储签名（既有行为不变）", async () => {
    const { harness, media, worker } = await startService({
      provider: providerWithUpload(undefined),
      readReferenceObject: async () => ({ bytes: Uint8Array.of(1), contentType: "image/png" })
    });
    try {
      const submission = await submit(harness.base);
      expect(submission.status, JSON.stringify(submission.body)).toBe(202);
      expect(worker.submitted[0]!.urls).toEqual([`https://cos.example/${REFERENCE_KEY}?signature=test`]);
      expect(media.signed).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
});
