/**
 * language 多模态提交：binding 门禁 + 组装形状（spec: pptask-task-gateway
 * 「Language 模型按 binding 接收多模态输入」）。
 *
 * 经真实内部 HTTP 协议驱动：只把 Media client 与 worker server 换成假实现，不碰真实存储与上游。
 *
 * 覆盖三件事：
 * 1. 模型声明了参考图 binding 时，提交的 provider input 里图片与文本同时到达（组装形状）；
 * 2. 模型**没有**对应 binding 时，提交被拒绝，不得静默退化成纯文本请求（fail closed）；
 * 3. binding 的 maxItems 上限同样在提交期拦截。
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
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-language-mm-"));
  dirs.push(dir);
  return path.join(dir, "task.sqlite");
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

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
  const submitted: Array<Record<string, unknown>> = [];
  const server = {
    async submit(input: { key: string; input: unknown }) {
      submitted.push(input.input as Record<string, unknown>);
      return { created: true, record: { key: input.key, providerId: "text-provider", status: "queued", attempt: 0 } };
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
const IMAGE_KEY = `generation-outputs/${"b".repeat(64)}.png`;

const REQUEST = {
  workerTaskKey: "run-language-1",
  canvasId: "canvas-1",
  nodeId: "text-1",
  runId: "run-language-1",
  jobId: "job-run-language-1",
  nodeType: "text",
  modelType: "language",
  modelKey: "text-provider:chat-vision",
  prompt: "这个图里面有什么",
  parameters: {},
  inputs: [
    {
      assetId: "asset-image-1",
      role: "reference_image",
      storageKey: IMAGE_KEY,
      mediaType: "image/png",
      mediaKind: "image"
    }
  ]
};

/** 与 litellm `describeText` 同形的参考图声明（`urls` + reference-image）。 */
function referenceImageSchema(maxItems: number): Record<string, unknown> {
  return {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string", title: "提示词" },
      urls: { type: "array", title: "参考图", "x-pptask-semantic": "reference-image", maxItems }
    }
  };
}

/** 没有任何参考输入能力的语言模型。 */
const TEXT_ONLY_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["prompt"],
  properties: { prompt: { type: "string", title: "提示词" } }
};

function languageProvider(inputSchema: Record<string, unknown>): GenerationProvider {
  return {
    extensionId: "text-provider",
    providerId: "text-provider",
    available: true,
    provider: {} as never,
    models: [
      {
        providerId: "text-provider",
        providerModelId: "chat-vision",
        modelType: "language",
        inputSchema,
        defaultInput: {}
      }
    ]
  };
}

type Harness = { base: string; close: () => Promise<void> };

async function startService(provider: GenerationProvider): Promise<{
  harness: Harness;
  media: ReturnType<typeof recordingMediaClient>;
  worker: ReturnType<typeof recordingWorkerServer>;
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
    media,
    worker,
    harness: {
      base: `http://127.0.0.1:${port}`,
      close: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await service.close();
      }
    }
  };
}

async function submit(
  base: string,
  overrides: Record<string, unknown> = {}
): Promise<{ status: number; body: unknown }> {
  const workerTaskKey = (overrides.workerTaskKey as string | undefined) ?? REQUEST.workerTaskKey;
  const response = await fetch(`${base}/internal/v1/tasks/${workerTaskKey}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-woohaa3-service-token": TOKEN,
      "x-woohaa3-protocol-version": "1"
    },
    body: JSON.stringify({ ...REQUEST, ...overrides, workerTaskKey, runId: workerTaskKey, jobId: workerTaskKey })
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

describe("language 多模态提交", () => {
  it("模型声明参考图 binding 时，文本与签名图片一起进入 provider input", async () => {
    const { harness, media, worker } = await startService(languageProvider(referenceImageSchema(4)));
    try {
      const submission = await submit(harness.base);
      expect(submission.status, JSON.stringify(submission.body)).toBe(202);
      expect(media.signed).toEqual([IMAGE_KEY]);
      const prompt = worker.submitted[0]!.prompt as Array<{ role: string; content: Array<Record<string, unknown>> }>;
      expect(prompt[0]!.role).toBe("user");
      expect(prompt[0]!.content).toEqual([
        { type: "text", text: "这个图里面有什么" },
        {
          type: "image_url",
          image_url: { url: `https://cos.example/${IMAGE_KEY}?signature=test` }
        }
      ]);
    } finally {
      await harness.close();
    }
  });

  it("模型没有对应 binding 时拒绝提交，不静默退化纯文本", async () => {
    const { harness, media, worker } = await startService(languageProvider(TEXT_ONLY_SCHEMA));
    try {
      const submission = await submit(harness.base);
      expect(submission.status).toBe(400);
      expect(submission.body).toMatchObject({ code: "unsupported" });
      expect((submission.body as { message: string }).message).toContain("不接受参考输入");
      // 不签 URL、不进 provider：fail closed 发生在媒体 materialize 之前。
      expect(media.signed).toEqual([]);
      expect(worker.submitted).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("超过 binding 的 maxItems 时在提交期拦截", async () => {
    const { harness, worker } = await startService(languageProvider(referenceImageSchema(1)));
    try {
      const second = {
        assetId: "asset-image-2",
        role: "reference_image",
        storageKey: `generation-outputs/${"c".repeat(64)}.png`,
        mediaType: "image/png",
        mediaKind: "image"
      };
      const submission = await submit(harness.base, {
        workerTaskKey: "run-language-2",
        inputs: [REQUEST.inputs[0], second]
      });
      expect(submission.status).toBe(400);
      expect(submission.body).toMatchObject({ code: "limit-exceeded" });
      expect(worker.submitted).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});
