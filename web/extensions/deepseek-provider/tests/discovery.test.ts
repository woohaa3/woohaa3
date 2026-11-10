import { describe, expect, it, vi } from "vitest";
import {
  deepSeekLanguageCapabilities,
  deepSeekModelDefinitions,
  discoverDeepSeekModels,
  isTextOutput,
  parseModelList
} from "../src/discovery.js";
import { DEEPSEEK_MODELS_PATH, DEEPSEEK_ORIGIN, DEEPSEEK_PLUGIN_METADATA, DEEPSEEK_PROVIDER_ID } from "../src/shared.js";
import MODELS from "./fixtures/models.json";

describe("DeepSeek 模型发现", () => {
  it("身份与地址是常量", () => {
    expect(DEEPSEEK_ORIGIN).toBe("https://api.deepseek.com");
    expect(DEEPSEEK_MODELS_PATH).toBe("/models");
    expect(DEEPSEEK_PROVIDER_ID).toBe("deepseek");
    expect(DEEPSEEK_PLUGIN_METADATA.extensionId).toBe("deepseek-provider");
    expect(DEEPSEEK_PLUGIN_METADATA.host).toBe("backend");
  });

  it("真实两条响应：视觉、输出上限与思考档位都取目录声明", () => {
    const models = parseModelList(MODELS);
    expect(models).toEqual([
      {
        id: "deepseek-flash",
        title: "DeepSeek-V4.1-Flash",
        supportsVision: true,
        maxOutputTokens: 393216,
        reasoningEfforts: ["low", "high", "max"],
        defaultReasoningEffort: "high"
      },
      {
        id: "deepseek-v4-pro",
        title: "DeepSeek-V4-Pro",
        supportsVision: false,
        maxOutputTokens: 393216,
        reasoningEfforts: ["low", "high", "max"],
        defaultReasoningEffort: "high"
      }
    ]);
  });

  it("元数据缺省时不推断能力，也不丢模型", () => {
    const models = parseModelList({ data: [{ id: "bare-model", object: "model", owned_by: "deepseek" }] });
    expect(models).toEqual([{ id: "bare-model", title: "bare-model", supportsVision: false }]);
    expect(models[0]).not.toHaveProperty("reasoningEfforts");
    expect(models[0]).not.toHaveProperty("maxOutputTokens");
  });

  it("只收文本输出模型：非文本输出与重复 id 被跳过", () => {
    expect(isTextOutput({})).toBe(true);
    expect(isTextOutput({ output_modalities: ["text"] })).toBe(true);
    expect(isTextOutput({ output_modalities: ["audio"] })).toBe(false);
    expect(isTextOutput({ output_modalities: [] })).toBe(true);
    expect(parseModelList({
      data: [
        { id: "audio-model", output_modalities: ["audio"] },
        { id: "text-model", output_modalities: ["text"] },
        { id: "text-model", name: "重复" }
      ]
    }).map((model) => model.id)).toEqual(["text-model"]);
  });

  it("目录形状不对时返回空数组，不抛错", () => {
    expect(parseModelList(null)).toEqual([]);
    expect(parseModelList({ data: "nope" })).toEqual([]);
    expect(parseModelList({ data: [null, 1, "x"] })).toEqual([]);
  });

  it("模型定义：有条目档位才声明推理能力", () => {
    const definitions = deepSeekModelDefinitions([
      ...parseModelList(MODELS),
      { id: "bare", title: "bare", supportsVision: false }
    ]);
    const flash = definitions.find((model) => model.providerModelId === "deepseek-flash");
    expect(flash).toMatchObject({
      providerId: "deepseek",
      providerModelId: "deepseek-flash",
      modelType: "language",
      title: "DeepSeek-V4.1-Flash",
      promptRequirement: "required",
      cancel: "local",
      capabilityFacts: { reasoning: { supported: true, efforts: ["low", "high", "max"] } }
    });
    const bare = definitions.find((model) => model.providerModelId === "bare");
    expect(bare).toEqual({
      providerId: "deepseek",
      providerModelId: "bare",
      modelType: "language",
      title: "bare",
      promptRequirement: "required",
      cancel: "local"
    });
  });

  it("语言能力证据按模型：工具与流式恒定，视觉取目录", () => {
    const models = parseModelList(MODELS);
    expect(deepSeekLanguageCapabilities(models, "deepseek-flash")).toEqual({ tools: true, imageInput: true, streaming: true });
    expect(deepSeekLanguageCapabilities(models, "deepseek-v4-pro")).toEqual({ tools: true, imageInput: false, streaming: true });
    expect(deepSeekLanguageCapabilities(models, "missing")).toBeUndefined();
  });

  it("用 Bearer 读取 /models", async () => {
    const fetchImpl = vi.fn(async () => Response.json(MODELS));
    const result = await discoverDeepSeekModels({ apiKey: "secret", fetchImpl: fetchImpl as typeof fetch });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.deepseek.com/models", expect.objectContaining({
      method: "GET",
      headers: { authorization: "Bearer secret", accept: "application/json" }
    }));
  });

  it("目录接口失败时返回可读原因，不外泄 Key", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 401 }));
    const result = await discoverDeepSeekModels({ apiKey: "sk-secret", fetchImpl: fetchImpl as typeof fetch });
    expect(result).toEqual({ ok: false, message: "读取 DeepSeek 模型目录失败（HTTP 401）" });
    expect(JSON.stringify(result)).not.toContain("sk-secret");
  });

  it("空目录视为失败：不把空目录当成功下发", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ object: "list", data: [] }));
    const result = await discoverDeepSeekModels({ apiKey: "secret", fetchImpl: fetchImpl as typeof fetch });
    expect(result).toEqual({ ok: false, message: "DeepSeek 模型目录没有可用的文本模型" });
  });
});
