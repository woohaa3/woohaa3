/**
 * 多 Provider 覆盖注册表
 * （change: add-audio-video-generation-and-align-model-catalog，任务 2.1–2.4）。
 *
 * Ark Provider 自身已迁为插件（change: 2026-10-06-extensionize-ark-provider），其测试见
 * `@woohaa3/extension-ark-provider`；此处只验证与 Provider 无关的注册表语义。
 */
import { describe, expect, it } from "vitest";
import { createTaskProviderRegistry } from "../src/providers/registry.js";

describe("多 Provider 注册表", () => {
  function fakeBundle(providerId: string, models: Array<{ modelId: string; modelType: "language" | "image" | "video" | "audio" }>) {
    return {
      providerId,
      provider: { providerId } as never,
      catalog: {
        listModels: () =>
          models.map((model) => ({ providerModelId: model.modelId, modelType: model.modelType })),
        describe: async () => ({ providerId, modelId: "x", modelType: "language" as const })
      }
    };
  }

  it("不同 Provider 的同名 providerModelId 拥有不同 modelKey", () => {
    const registry = createTaskProviderRegistry([
      fakeBundle("litellm", [
        { modelId: "gemini-2.5-flash", modelType: "language" },
        { modelId: "video-pro", modelType: "video" }
      ]),
      fakeBundle("gemini", [{ modelId: "gemini-2.5-flash", modelType: "language" }])
    ]);
    expect(registry.resources.map((resource) => resource.modelKey)).toEqual([
      "litellm:gemini-2.5-flash",
      "litellm:video-pro",
      "gemini:gemini-2.5-flash"
    ]);
    expect(registry.resolveResource("litellm:gemini-2.5-flash")?.providerId).toBe("litellm");
    expect(registry.resolveResource("gemini:gemini-2.5-flash")?.providerId).toBe("gemini");
  });

  it("同一 Provider 内重复 modelKey 去重，先注册优先", () => {
    const registry = createTaskProviderRegistry([
      fakeBundle("litellm", [{ modelId: "gpt-image-2", modelType: "image" }]),
      fakeBundle("litellm", [{ modelId: "gpt-image-2", modelType: "image" }])
    ]);
    expect(registry.resources).toHaveLength(1);
  });

  it("按 providerId 解析 Provider；未知返回 undefined", () => {
    const registry = createTaskProviderRegistry([fakeBundle("ark", [{ modelId: "seedance2_0", modelType: "video" }])]);
    expect(registry.resolveProvider("ark")).toBeDefined();
    expect(registry.resolveProvider("nope")).toBeUndefined();
    expect(registry.resolveResource("ark:seedance2_0")?.providerId).toBe("ark");
  });

  it("catalog 只暴露注册资源且能 describe", async () => {
    const registry = createTaskProviderRegistry([
      fakeBundle("litellm", [{ modelId: "gpt-image-2", modelType: "image" }])
    ]);
    expect(registry.catalog.listModels()).toEqual([
      { modelKey: "litellm:gpt-image-2", providerId: "litellm", providerModelId: "gpt-image-2", modelType: "image" }
    ]);
    const described = await registry.catalog.describe("litellm:gpt-image-2");
    expect(described).toMatchObject({ providerId: "litellm" });
  });
});

