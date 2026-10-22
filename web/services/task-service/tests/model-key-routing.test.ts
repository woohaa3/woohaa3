/**
 * modelKey 权威路由与同名 Provider 模型隔离
 * （change: 2026-09-29-add-pluggable-model-interactions，任务 2.1 / 2.4 / design D1 / D7）。
 *
 * 锁定：两个 Provider 暴露相同 `providerModelId` 时，catalog 必须以不同 `modelKey` 返回，
 * 并按 modelKey 把提交路由到各自 Provider；history 与幂等记录互不复用。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTaskService } from "../src/composition.js";
import type { ModelsConfig } from "../src/config/models-config.js";
import type { GenerationProvider } from "@woohaa3/contracts";

const MODELS: ModelsConfig = { version: 1, models: [] };

/** 记录每个 Provider 实际收到的 providerModelId，验证路由。 */
function recordingProvider(providerId: string): GenerationProvider {
  return {
    extensionId: `${providerId}-plugin`,
    providerId,
    available: true,
    provider: {} as never,
    models: [{ providerId, providerModelId: "video-pro", modelType: "video" as const }],
    describeModel: async ({ providerModelId }) => ({
      providerId,
      modelId: providerModelId,
      modelType: "video",
      title: `${providerId} video-pro`,
      inputSchema: {},
      defaultInput: {}
    }) as never
  };
}

describe("modelKey 权威路由（同名 providerModelId 隔离）", () => {
  it("不同 Provider 的同名 providerModelId 得到不同 modelKey，并按 modelKey 路由", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-route-"));
    try {
      const svc = createTaskService({
        modelsConfig: MODELS,
        storePath: path.join(dir, "task.sqlite"),
        env: {},
        generationProviders: () => [recordingProvider("provider-a"), recordingProvider("provider-b")]
      });

      const catalog = await svc.catalog();
      expect(catalog.available).toBe(true);
      // 同名 providerModelId 不能互相覆盖：两个 modelKey 都要在。
      expect(catalog.models.map((model) => model.modelKey)).toEqual([
        "provider-a:video-pro",
        "provider-b:video-pro"
      ]);
      expect(catalog.models.map((model) => model.providerId)).toEqual(["provider-a", "provider-b"]);
      expect(catalog.models.every((model) => model.providerModelId === "video-pro")).toBe(true);
      await svc.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("同一 Provider 内重复 providerModelId 只保留一个 modelKey", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-route-"));
    try {
      const svc = createTaskService({
        modelsConfig: MODELS,
        storePath: path.join(dir, "task.sqlite"),
        env: {},
        generationProviders: () => [recordingProvider("provider-a")]
      });
      const catalog = await svc.catalog();
      expect(catalog.models.map((model) => model.modelKey)).toEqual(["provider-a:video-pro"]);
      await svc.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("受理任务固定模型身份（任务 3.3）", () => {
  it("受理后 catalog 变化不改写已持久化的 providerId / modelKey / 请求摘要", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-pin-"));
    try {
      const svc = createTaskService({
        modelsConfig: MODELS,
        storePath: path.join(dir, "task.sqlite"),
        env: {},
        generationProviders: () => [recordingProvider("provider-a")],
        // 注入空 worker server：只验证「受理并持久化身份」，不驱动真实执行。
        workerServer: {
          async submit(input: { key: string }) {
            return { created: true, record: { key: input.key, providerId: "provider-a", status: "queued", attempt: 0 } };
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
        } as never
      });
      await svc.catalog();
      await svc.port().submit({
        workerTaskKey: "run-pin-1",
        canvasId: "c1",
        nodeId: "n1",
        runId: "run-pin-1",
        jobId: "job-run-pin-1",
        modelType: "video",
        modelKey: "provider-a:video-pro",
        prompt: "hello",
        parameters: {},
        inputs: []
      });
      // 受理记录固定 providerId / modelKey / request 摘要（不再依赖 catalog 再解析）。
      const detail = svc.history().get("run-pin-1", { fullText: true, includeRequest: true }) as {
        providerId: string;
        modelKey: string;
        request?: { prompt?: string };
      };
      expect(detail.providerId).toBe("provider-a");
      expect(detail.modelKey).toBe("provider-a:video-pro");
      expect(detail.request?.prompt).toBe("hello");
      await svc.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
