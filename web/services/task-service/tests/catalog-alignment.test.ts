/**
 * 模型目录对齐（change: add-audio-video-generation-and-align-model-catalog，任务 2.1–2.5）。
 *
 * 用 Task Service 自己的 catalog 构建路径验证：
 * - 空 models 配置 = 启用全部已注册资源（含 audio）；
 * - 显式白名单只返回列出的模型；
 * - 未知 modelId 使 catalog 整体不可用；
 * - bindings 由 describe 派生（catalog 只写 bindings，旧图片字段不再生效）。
 */
import { describe, expect, it } from "vitest";
import { buildCanvasTaskCatalog } from "../src/catalog/build-catalog.ts";
import { parseModelsConfig } from "../src/config/models-config.ts";
import type { DescribedModel, TaskCatalogProvider } from "../src/catalog/types.ts";
import type { CanvasTaskModelType } from "@woohaa3/contracts";

const REGISTRY: Array<{ modelKey: string; providerId: string; providerModelId: string; modelType: CanvasTaskModelType }> = [
  { modelKey: "litellm:gemini-2.5-flash", providerId: "litellm", providerModelId: "gemini-2.5-flash", modelType: "language" },
  { modelKey: "litellm:gpt-image-2", providerId: "litellm", providerModelId: "gpt-image-2", modelType: "image" },
  { modelKey: "litellm:gemini-3.1-flash-image", providerId: "litellm", providerModelId: "gemini-3.1-flash-image", modelType: "image" },
  { modelKey: "litellm:minimax-speech-2.8-hd", providerId: "litellm", providerModelId: "minimax-speech-2.8-hd", modelType: "audio" },
  { modelKey: "litellm:minimax-music-2.6", providerId: "litellm", providerModelId: "minimax-music-2.6", modelType: "audio" }
];

/** 假 provider：静态 describe，图片模型带图片 binding，音频模型无参考输入。 */
function fakeProvider(): TaskCatalogProvider {
  return {
    listModels: () => REGISTRY.map((entry) => ({ ...entry })),
    describe: async (modelKey) => {
      const entry = REGISTRY.find((candidate) => candidate.modelKey === modelKey)!;
      const base: DescribedModel = {
        providerId: entry.providerId,
        modelId: entry.providerModelId,
        modelType: entry.modelType,
        title: entry.providerModelId,
        inputSchema: {},
        defaultInput: {}
      };
      if (entry.modelType === "image") {
        base.inputSchema = {
          type: "object",
          properties: { urls: { type: "array", maxItems: 16, "x-pptask-semantic": "reference-image" } }
        };
      }
      return base;
    }
  };
}

function config(models: unknown[]) {
  const parsed = parseModelsConfig({ version: 1, models });
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.config;
}

describe("catalog 对齐", () => {
  it("空 models 配置启用全部注册资源（含 audio）", async () => {
    const catalog = await buildCanvasTaskCatalog(fakeProvider(), config([]));
    expect(catalog.available).toBe(true);
    expect(catalog.models.map((model) => model.modelKey)).toEqual(REGISTRY.map((entry) => entry.modelKey));
    expect(catalog.models.some((model) => model.modelType === "audio")).toBe(true);
    expect(DEFAULT_AUDIO_TIMEOUT(catalog)).toBe(8 * 60_000);
  });

  it("显式白名单只返回列出的模型并应用排序", async () => {
    const catalog = await buildCanvasTaskCatalog(
      fakeProvider(),
      config([
        { id: "litellm:minimax-speech-2.8-hd", order: 0 },
        { id: "litellm:gpt-image-2", order: 1 }
      ])
    );
    expect(catalog.available).toBe(true);
    expect(catalog.models.map((model) => model.modelKey)).toEqual(["litellm:minimax-speech-2.8-hd", "litellm:gpt-image-2"]);
  });

  it("未知 modelId 使 catalog 整体不可用", async () => {
    const catalog = await buildCanvasTaskCatalog(fakeProvider(), config([{ id: "no-such-model" }]));
    expect(catalog.available).toBe(false);
    expect(catalog.reason).toContain("no-such-model");
    expect(catalog.models).toEqual([]);
  });

  it("图片模型写出 bindings（无旧兼容字段）", async () => {
    const catalog = await buildCanvasTaskCatalog(fakeProvider(), config([]));
    const image = catalog.models.find((model) => model.modelKey === "litellm:gpt-image-2");
    expect(image?.bindings).toEqual([
      {
        field: "urls",
        semantic: "reference-image",
        roles: ["reference_image"],
        mediaKinds: ["image"],
        mediaTypes: ["image/png", "image/jpeg", "image/webp"],
        maxItems: 16,
        valueFormat: "url"
      }
    ]);
    // change: 2026-10-07-remove-residual-compatibility —— 不再写出旧图片能力字段。
    expect(image).not.toHaveProperty("acceptsImages");
    expect(image).not.toHaveProperty("maxReferences");
  });

  it("运营可用 referenceInput.bindings 覆盖", async () => {
    const catalog = await buildCanvasTaskCatalog(
      fakeProvider(),
      config([
        {
          id: "litellm:gpt-image-2",
          referenceInput: {
            bindings: [
              { field: "urls", semantic: "reference-video", maxItems: 2, mediaTypes: ["video/mp4"] }
            ]
          }
        }
      ])
    );
    const image = catalog.models[0];
    expect(image?.bindings).toEqual([
      {
        field: "urls",
        semantic: "reference-video",
        roles: ["reference_video"],
        mediaKinds: ["video"],
        mediaTypes: ["video/mp4"],
        maxItems: 2,
        valueFormat: "url"
      }
    ]);
  });
});

function DEFAULT_AUDIO_TIMEOUT(catalog: Awaited<ReturnType<typeof buildCanvasTaskCatalog>>): number {
  const audio = catalog.models.find((model) => model.modelType === "audio");
  return audio?.taskTimeoutMs ?? -1;
}
