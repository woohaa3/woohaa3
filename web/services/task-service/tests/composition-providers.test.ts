/**
 * Task Service composition：多 Provider 目录与路由
 * （change: add-audio-video-generation-and-align-model-catalog，任务 2.3 / 2.4 / 6.1；
 *  change: 2026-10-07-remove-residual-compatibility —— Provider 只经 generation 扩展点）。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTaskService } from "../src/composition.js";
import type { ModelsConfig } from "../src/config/models-config.js";
import type { GenerationProvider } from "@woohaa3/contracts";

const MODELS: ModelsConfig = { version: 1, models: [] };

/** 假 Ark 生成 Provider（Ark 已是插件；这里只验证目录语义）。 */
function fakeArkProvider(models: ReadonlyArray<"seedance2_0" | "seedance2_5">): GenerationProvider {
  return {
    extensionId: "ark-provider",
    providerId: "ark",
    available: true,
    provider: {} as never,
    models: models.map((modelId) => ({ providerId: "ark", providerModelId: modelId, modelType: "video" as const })),
    describeModel: async ({ providerModelId }) => ({
      providerId: "ark",
      modelId: providerModelId,
      modelType: "video",
      title: providerModelId,
      inputSchema: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" } } },
      defaultInput: {}
    }) as never
  };
}

/** 假 LiteLLM 生成 Provider。 */
function fakeLitellmProvider(): GenerationProvider {
  return {
    extensionId: "litellm-provider",
    providerId: "litellm",
    available: true,
    provider: {} as never,
    models: [
      { providerId: "litellm", providerModelId: "gemini-2.5-flash", modelType: "language" },
      { providerId: "litellm", providerModelId: "gpt-image-2", modelType: "image" }
    ]
  };
}

function service(overrides: Parameters<typeof createTaskService>[0]) {
  return createTaskService(overrides);
}

describe("composition 多 Provider", () => {
  it("LiteLLM + Ark 同时可用时，catalog 同时出现文本/图片与视频模型", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-ark-"));
    try {
      const svc = service({
        modelsConfig: MODELS,
        storePath: path.join(dir, "task.sqlite"),
        env: { LITELLM_API_KEY: "k", LITELLM_BASE_URL: "https://llm.example/v1" },
        generationProviders: () => [fakeLitellmProvider(), fakeArkProvider(["seedance2_0", "seedance2_5"])]
      });
      const catalog = await svc.catalog();
      expect(catalog.available).toBe(true);
      expect(catalog.models.map((model) => model.modelKey)).toEqual([
        "litellm:gemini-2.5-flash",
        "litellm:gpt-image-2",
        "ark:seedance2_0",
        "ark:seedance2_5"
      ]);
      expect(catalog.models.find((model) => model.modelKey === "ark:seedance2_0")?.modelType).toBe("video");
      await svc.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Ark 未注册时 catalog 只含 LiteLLM 资源", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-ark-"));
    try {
      const svc = service({
        modelsConfig: MODELS,
        storePath: path.join(dir, "task.sqlite"),
        env: {},
        generationProviders: () => [fakeLitellmProvider()]
      });
      const catalog = await svc.catalog();
      expect(catalog.models.map((model) => model.modelKey)).toEqual([
        "litellm:gemini-2.5-flash",
        "litellm:gpt-image-2"
      ]);
      await svc.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("无任何 Provider 时 catalog 返回不可用", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-ark-"));
    try {
      const svc = service({
        modelsConfig: MODELS,
        storePath: path.join(dir, "task.sqlite"),
        env: {}
      });
      const catalog = await svc.catalog();
      expect(catalog.available).toBe(false);
      await svc.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("多个生成插件 Provider 共存：视频/图片模型都不丢失", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-ark-"));
    try {
      const plugins: GenerationProvider[] = [
        {
          extensionId: "litellm-provider",
          providerId: "litellm",
          available: true,
          provider: {} as never,
          models: [{ providerId: "litellm", providerModelId: "gpt-image-2", modelType: "image" }]
        },
        {
          extensionId: "runninghub-provider",
          providerId: "runninghub",
          available: true,
          provider: {} as never,
          models: [{ providerId: "runninghub", providerModelId: "api/seedream-v5-pro", modelType: "image" }]
        },
        fakeArkProvider(["seedance2_0"])
      ];
      const svc = service({
        modelsConfig: MODELS,
        storePath: path.join(dir, "task.sqlite"),
        env: {},
        generationProviders: () => plugins
      });
      const catalog = await svc.catalog();
      const keys = catalog.models.map((model) => model.modelKey);
      expect(keys).toContain("litellm:gpt-image-2");
      expect(keys).toContain("runninghub:api/seedream-v5-pro");
      expect(keys).toContain("ark:seedance2_0");
      expect(catalog.models.find((model) => model.modelKey === "ark:seedance2_0")?.modelType).toBe("video");
      await svc.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
