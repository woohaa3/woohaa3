/**
 * 提交阶段失败必须落「安全失败终态」
 * （change: 2026-10-21-record-submit-failures-as-terminal-state）。
 *
 * spec `canvas-reference-inputs`「materialization 失败 / 签名 URL 生成失败」要求 Task Service 在
 * 调用主生成接口前把任务置为安全失败终态，由 projector 消费。缺陷现场：签到失败只把
 * `mediaError` 返回调用方、history 里什么都没有，于是画布节点永久 processing、生成溯源按
 * taskKey 读详情 404（展示成「任务不存在或已超过保留期」）、任务监控里也看不到这条失败。
 *
 * 经真实内部 HTTP 协议驱动（复用 composition 的 handle），只替换 Media client 与 worker server。
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
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-submit-failure-"));
  dirs.push(dir);
  return path.join(dir, "task.sqlite");
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const REFERENCE_KEY = `generation-outputs/${"b".repeat(64)}.png`;

const REQUEST = {
  workerTaskKey: "run-submit-failure-1",
  canvasId: "canvas-1",
  nodeId: "image-1",
  runId: "run-submit-failure-1",
  jobId: "job-run-submit-failure-1",
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

function provider(): GenerationProvider {
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
    ]
  };
}

function failingMediaClient(signError: Error) {
  const signed: string[] = [];
  return {
    signed,
    client: {
      async verify() {
        return { exists: true, matches: true };
      },
      async sign(storageKey: string) {
        signed.push(storageKey);
        throw signError;
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

async function startService(signError: Error, generationProvider: GenerationProvider = provider()) {
  const media = failingMediaClient(signError);
  const worker = recordingWorkerServer();
  const service: TaskService = createTaskService({
    modelsConfig: MODELS,
    storePath: tempStore(),
    env: { WOOHAA3_TASK_STORE_PATH: tempStore() },
    generationProviders: () => [generationProvider],
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

async function submit(base: string, request: Record<string, unknown> = REQUEST) {
  const response = await fetch(`${base}/internal/v1/tasks/${String(request.workerTaskKey)}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-woohaa3-service-token": TOKEN,
      "x-woohaa3-protocol-version": "1"
    },
    body: JSON.stringify(request)
  });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as { code?: string; message?: string } };
}

describe("提交阶段失败落安全失败终态", () => {
  it("签名失败时写入 failed 记录（带画布关联与错误摘要），且不调 provider", async () => {
    const harness = await startService(new Error("媒体对象不存在"));
    try {
      const submission = await submit(harness.base);
      expect(submission.status, JSON.stringify(submission.body)).toBe(502);
      expect(harness.worker.submitted).toHaveLength(0);

      const detail = harness.service.history().get(REQUEST.workerTaskKey, { includeRequest: true });
      expect(detail, "history 必须留下这条失败").toBeDefined();
      expect(detail!.state).toBe("failed");
      expect(detail!.error?.message).toBe("媒体对象不存在");
      // projector 只认这四个关联字段：缺任一项都会被当成「无法投影」丢弃
      // （jobId 按契约不进 DTO，画布侧由 runId 派生 `job-<runId>`，见 result-consumer.readJobId）。
      expect(detail!.canvasId).toBe(REQUEST.canvasId);
      expect(detail!.nodeId).toBe(REQUEST.nodeId);
      expect(detail!.runId).toBe(REQUEST.runId);
      expect(`job-${detail!.runId}`).toBe(REQUEST.jobId);
      expect(detail!.finishedAt).toBeTruthy();
      expect(detail!.durationMs).toBe(0);
      // 生成溯源正文会读请求摘要，失败记录同样要带得动。
      expect(detail!.request?.prompt).toBe(REQUEST.prompt);
      expect(detail!.request?.inputs?.[0]?.storageKey).toBe(REFERENCE_KEY);
    } finally {
      await harness.close();
    }
  });

  it("失败原因里的 URL 被抹掉（历史不得落签名 URL）", async () => {
    const harness = await startService(new Error("签名失败 https://cos.example/obj.png?signature=secret"));
    try {
      await submit(harness.base);
      const detail = harness.service.history().get(REQUEST.workerTaskKey, { includeRequest: true });
      expect(detail!.state).toBe("failed");
      expect(detail!.error?.message).not.toContain("cos.example");
      expect(detail!.error?.message).toContain("签名失败");
    } finally {
      await harness.close();
    }
  });

  it("失败记录进 history 增量流，画布补偿能消费到", async () => {
    const harness = await startService(new Error("媒体对象不存在"));
    try {
      await submit(harness.base);
      const batch = harness.service.history().listSince(0, 50);
      expect(batch.messages.some((message) => message.record.taskKey === REQUEST.workerTaskKey)).toBe(true);
    } finally {
      await harness.close();
    }
  });
});

/**
 * 视频参数 schema 复验（change: 2026-11-06-guard-video-generation-inputs）。
 *
 * 绕过 Canvas 直接调用内部提交协议时，Task Service 也必须在创建 provider 任务前拒绝
 * 缺参/越界请求；不能把 N05/N09 的空 aspectRatio / 越界 duration 交给上游。
 */
function videoProvider(defaultInput: Record<string, unknown> = {
  aspectRatio: "16:9",
  resolution: "720p",
  durationSeconds: 5
}): GenerationProvider {
  return {
    extensionId: "video-provider",
    providerId: "videohub",
    available: true,
    provider: {} as never,
    models: [
      {
        providerId: "videohub",
        providerModelId: "agnes-video-2.5",
        modelType: "video",
        inputSchema: {
          type: "object",
          required: ["prompt", "aspectRatio", "resolution", "durationSeconds"],
          properties: {
            prompt: { type: "string", title: "提示词" },
            aspectRatio: { type: "string", title: "比例", enum: ["16:9", "9:16", "1:1"] },
            resolution: { type: "string", title: "分辨率", enum: ["720p", "1080p", "2k"] },
            durationSeconds: { type: "number", title: "时长", minimum: 5, maximum: 12, unit: "秒" }
          }
        },
        defaultInput: defaultInput
      }
    ]
  };
}

const VIDEO_REQUEST = {
  ...REQUEST,
  workerTaskKey: "run-video-parameters-1",
  nodeId: "video-1",
  runId: "run-video-parameters-1",
  jobId: "job-run-video-parameters-1",
  nodeType: "video",
  modelType: "video",
  modelKey: "videohub:agnes-video-2.5",
  inputs: []
};

describe("视频参数 schema 复验", () => {
  it("缺 aspectRatio 时返回稳定 missing-parameter 且不调用 provider", async () => {
    const harness = await startService(new Error("不应读取参考输入"), videoProvider({}));
    try {
      const submission = await submit(harness.base, {
        ...VIDEO_REQUEST,
        parameters: { resolution: "720p", durationSeconds: 5 }
      });
      expect(submission.status, JSON.stringify(submission.body)).toBe(400);
      expect(submission.body?.code).toBe("missing-parameter");
      expect(submission.body?.message).toContain("缺少必填参数");
      expect(submission.body?.message).toContain("aspectRatio");
      expect(harness.worker.submitted).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("时长越界时返回稳定 invalid-parameter 且不调用 provider", async () => {
    const harness = await startService(new Error("不应读取参考输入"), videoProvider());
    try {
      const submission = await submit(harness.base, {
        ...VIDEO_REQUEST,
        parameters: { aspectRatio: "16:9", resolution: "720p", durationSeconds: 13 }
      });
      expect(submission.status, JSON.stringify(submission.body)).toBe(400);
      expect(submission.body?.code).toBe("invalid-parameter");
      expect(submission.body?.message).toContain("时长不能大于 12秒");
      expect(harness.worker.submitted).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("缺省参数被模型默认值补齐后才调用 provider", async () => {
    const harness = await startService(new Error("签名失败"), videoProvider());
    try {
      const submission = await submit(harness.base, {
        ...VIDEO_REQUEST,
        parameters: { aspectRatio: "9:16" }
      });
      expect(submission.status, JSON.stringify(submission.body)).toBe(202);
      expect(harness.worker.submitted).toHaveLength(1);
      expect(harness.worker.submitted[0]).toMatchObject({
        aspectRatio: "9:16",
        resolution: "720p",
        durationSeconds: 5
      });
    } finally {
      await harness.close();
    }
  });
});
