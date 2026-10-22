/**
 * Provider 输入上下文：画布身份 + 幂等键 + 参考输入稳定身份
 * （change: 2026-10-20-reserve-remote-generation-provider，任务 3.5）。
 *
 * 远端托管 Provider 提交时需要 `canvasId`（服务端 ACL / 对象键作用域）、`taskKey`（幂等键）
 * 与每份参考输入的 `assetId`/`storageKey`（稳定引用，不能依赖本机签名 URL）。这些事实由
 * Task Service 在调用 `prepareInput`/`resolveProviderModel` 时透传。
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { GenerationPrepareInput, GenerationProvider } from "@woohaa3/contracts";
import { createTaskService } from "../src/composition.js";
import type { ModelsConfig } from "../src/config/models-config.js";

const MODELS: ModelsConfig = { version: 1, models: [] };
const TOKEN = "test-token";
const dirs: string[] = [];

function tempStore(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-provider-input-"));
  dirs.push(dir);
  return path.join(dir, "task.sqlite");
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const IMAGE_KEY = `generation-outputs/${"b".repeat(64)}.png`;

function recordingMediaClient() {
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
  return client;
}

function recordingWorkerServer() {
  const submitted: Array<Record<string, unknown>> = [];
  const server = {
    async submit(input: { key: string; input: unknown }) {
      submitted.push(input.input as Record<string, unknown>);
      return { created: true, record: { key: input.key, providerId: "remote-server", status: "queued", attempt: 0 } };
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

/** 声明参考图 binding 的远端 Provider；捕获交给 prepareInput 的规范输入。 */
function remoteProvider(captured: { prepare?: GenerationPrepareInput }): GenerationProvider {
  return {
    extensionId: "remote-server",
    providerId: "remote-server",
    available: true,
    selectionAuthority: "server",
    catalogRevision: 3,
    provider: {} as never,
    models: [
      {
        providerId: "remote-server",
        providerModelId: "image-edit",
        modelType: "image",
        inputSchema: {
          type: "object",
          required: ["prompt"],
          properties: {
            prompt: { type: "string", title: "提示词" },
            urls: { type: "array", title: "参考图", "x-pptask-semantic": "reference-image", maxItems: 4 }
          }
        },
        defaultInput: {}
      }
    ],
    prepareInput: (input) => {
      captured.prepare = input;
      return { prompt: input.prompt, urls: input.references.map((reference) => reference.storageKey ?? "") };
    }
  };
}

const REQUEST = {
  workerTaskKey: "run-remote-1",
  canvasId: "canvas-remote",
  nodeId: "image-1",
  runId: "run-remote-1",
  jobId: "job-remote-1",
  nodeType: "image",
  modelType: "image",
  modelKey: "remote-server:image-edit",
  prompt: "把它改成水彩风格",
  parameters: { strength: 0.6 },
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

async function startService(provider: GenerationProvider) {
  const worker = recordingWorkerServer();
  const service = createTaskService({
    modelsConfig: MODELS,
    storePath: tempStore(),
    env: { WOOHAA3_TASK_STORE_PATH: tempStore() },
    generationProviders: () => [provider],
    mediaClient: recordingMediaClient() as never,
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
    worker,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await service.close();
    }
  };
}

async function submit(base: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}/internal/v1/tasks/${REQUEST.workerTaskKey}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-woohaa3-service-token": TOKEN,
      "x-woohaa3-protocol-version": "1"
    },
    body: JSON.stringify(REQUEST)
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

describe("prepareInput 收到画布身份与稳定引用", () => {
  it("透传 canvasId/taskKey/runId，以及参考输入的 assetId/storageKey", async () => {
    const captured: { prepare?: GenerationPrepareInput } = {};
    const harness = await startService(remoteProvider(captured));
    try {
      const submission = await submit(harness.base);
      expect(submission.status, JSON.stringify(submission.body)).toBe(202);
      expect(harness.worker.submitted).toHaveLength(1);

      const input = captured.prepare!;
      expect(input).toMatchObject({
        providerModelId: "image-edit",
        modelType: "image",
        prompt: "把它改成水彩风格",
        parameters: { strength: 0.6 },
        canvasId: "canvas-remote",
        taskKey: "run-remote-1",
        runId: "run-remote-1"
      });
      expect(input.references).toEqual([
        {
          role: "reference_image",
          mediaKind: "image",
          mediaType: "image/png",
          url: `https://cos.example/${IMAGE_KEY}?signature=test`,
          assetId: "asset-image-1",
          storageKey: IMAGE_KEY
        }
      ]);
      // provider 自己决定只用稳定引用（不把签名地址交给服务端）。
      expect(harness.worker.submitted[0]).toMatchObject({ urls: [IMAGE_KEY] });
    } finally {
      await harness.close();
    }
  });
});
