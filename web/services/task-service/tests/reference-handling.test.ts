/**
 * 参考输入传递方式（change: 2026-10-21-record-submit-failures-as-terminal-state 的后续重构）
 *
 * 契约 `GenerationProvider.referenceHandling` 决定 Task 在调 Provider 前做什么：
 * - `url`（缺省）：先问 Provider 的 `uploadReference`，否则由存储 expose 签出地址；
 * - `storage-key`：既不签地址、也不上传字节，直接把画布资产的稳定键交过去。
 *
 * 远端托管生成属于后者：服务端按 (canvas_id, storage_key) 读自己的对象，而这张画布的媒体
 * 已由归属路由放在服务端，任何"再复制一份"都是多余且会制造键身份分裂的（2026-10-21 现场）。
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { GenerationPrepareInput, GenerationProvider, GenerationTaskReference } from "@woohaa3/contracts";
import { createTaskService, type TaskService } from "../src/composition.js";
import type { ModelsConfig } from "../src/config/models-config.js";

const MODELS: ModelsConfig = { version: 1, models: [] };
const TOKEN = "test-token";
const dirs: string[] = [];

function tempStore(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-reference-handling-"));
  dirs.push(dir);
  return path.join(dir, "task.sqlite");
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const OUT_KEY = `generation-outputs/${"a".repeat(64)}.png`;

function requestWith(storageKey: string) {
  return {
    workerTaskKey: "run-ref-1",
    canvasId: "canvas-1",
    nodeId: "image-1",
    runId: "run-ref-1",
    jobId: "job-run-ref-1",
    nodeType: "image",
    modelType: "image",
    modelKey: "remote:model-1",
    prompt: "一只猫",
    parameters: {},
    inputs: [
      { assetId: "asset-image-1", role: "reference_image", storageKey, mediaType: "image/png", mediaKind: "image" }
    ]
  };
}

function providerWith(options: {
  seen: GenerationTaskReference[][];
  uploadReference?: GenerationProvider["uploadReference"];
}): GenerationProvider {
  return {
    extensionId: "remote-provider",
    providerId: "remote",
    available: true,
    provider: {} as never,
    referenceHandling: "storage-key",
    models: [
      {
        providerId: "remote",
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
    prepareInput: (input: GenerationPrepareInput) => {
      options.seen.push([...input.references]);
      return { prompt: input.prompt, transports: "storage-key" };
    },
    ...(options.uploadReference ? { uploadReference: options.uploadReference } : {})
  };
}

function mediaClient() {
  const calls = { signed: [] as string[], verified: [] as string[] };
  return {
    calls,
    client: {
      async verify(storageKey: string) {
        calls.verified.push(storageKey);
        return { exists: true, matches: true };
      },
      async sign(storageKey: string) {
        calls.signed.push(storageKey);
        return `https://cos.example/${storageKey}?sig=test`;
      },
      async importFromUrl() {
        throw new Error("unused");
      },
      async importBytes() {
        throw new Error("unused");
      }
    }
  };
}

function workerServer() {
  const submitted: Array<Record<string, unknown>> = [];
  return {
    submitted,
    server: {
      async submit(input: { key: string; input: unknown }) {
        submitted.push(input.input as Record<string, unknown>);
        return { created: true, record: { key: input.key, providerId: "remote", status: "queued", attempt: 0 } };
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
  };
}

async function start(provider: GenerationProvider) {
  const media = mediaClient();
  const worker = workerServer();
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
    service,
    media,
    worker,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await service.close();
    }
  };
}

async function submit(base: string, body: ReturnType<typeof requestWith>) {
  const response = await fetch(`${base}/internal/v1/tasks/${body.workerTaskKey}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-woohaa3-service-token": TOKEN,
      "x-woohaa3-protocol-version": "1"
    },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as { message?: string } };
}

describe("referenceHandling: storage-key", () => {
  it("直接用稳定键，不签地址也不调 uploadReference", async () => {
    const seen: GenerationTaskReference[][] = [];
    let uploadCalls = 0;
    const harness = await start(
      providerWith({
        seen,
        uploadReference: () => {
          uploadCalls += 1;
          return "https://uploader.example/should-not-be-used";
        }
      })
    );
    try {
      const result = await submit(harness.base, requestWith(OUT_KEY));
      expect(result.status, JSON.stringify(result.body)).toBe(202);
      // 两条旧路径都必须不被触碰。
      expect(harness.media.calls.signed).toEqual([]);
      expect(uploadCalls).toBe(0);
      // Provider 拿到的是稳定键，没有任何执行期地址。
      expect(seen).toHaveLength(1);
      expect(seen[0]).toHaveLength(1);
      expect(seen[0]![0]).toMatchObject({ role: "reference_image", storageKey: OUT_KEY, assetId: "asset-image-1" });
      expect(seen[0]![0]!.url).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it("HTTP 边界先按协议拒绝非法键", async () => {
    const seen: GenerationTaskReference[][] = [];
    const harness = await start(providerWith({ seen }));
    try {
      const result = await submit(harness.base, requestWith(`generation-inputs/${"b".repeat(64)}.png`));
      // 内部协议在解码阶段就要求合法 storageKey，不会走到 Provider。
      expect(result.status, JSON.stringify(result.body)).toBe(400);
      expect(seen).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("进程内提交（画布 → port）对非法键也稳定失败并落历史", async () => {
    const seen: GenerationTaskReference[][] = [];
    const harness = await start(providerWith({ seen }));
    try {
      // 画布走的是进程内 port，绕过 HTTP 解码校验，因此这一层必须自己拦。
      await expect(
        harness.service.port().submit(requestWith(`generation-inputs/${"b".repeat(64)}.png`) as never)
      ).rejects.toThrow("参考素材键不合法");
      expect(seen).toHaveLength(0);
      expect(harness.media.calls.signed).toEqual([]);
      const detail = harness.service.history().get("run-ref-1", { includeRequest: true });
      expect(detail?.state).toBe("failed");
      expect(detail?.error?.name).toBe("ReferenceInputUnavailable");
    } finally {
      await harness.close();
    }
  });
});
