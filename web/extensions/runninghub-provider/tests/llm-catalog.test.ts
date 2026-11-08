import { describe, expect, it } from "vitest";
import {
  discoverRunningHubLanguageModels,
  languageCatalog,
  parseRunningHubLanguageCatalog,
  resetRunningHubLanguageModels,
  runningHubLanguageCapabilities,
  runningHubLanguageDefinitions,
  setRunningHubLanguageModels
} from "../src/llm-catalog.js";

const CATALOG = {
  object: "list",
  data: [
    { id: "glm/glm-5.2", capabilities: { chat: true, tools: true, vision: false, streaming: true, thinking: true }, context_length: 1_000_000 },
    { id: "openai/vision", capabilities: { chat: true, tools: false, vision: true, streaming: true }, context_length: 128_000 },
    { id: "typesafe/decision-only", capabilities: { chat: false, decisions: true } },
    { id: "legacy/model", capabilities: { chat: true, streaming: false }, deprecated: true, redirect_to: "glm/glm-5.2" },
    { id: "glm/glm-5.2", capabilities: { chat: true } }
  ]
};

describe("RunningHub 文字目录", () => {
  it("只发布有 chat 证据的模型，逐模型能力不从提供商品牌推测", () => {
    const parsed = parseRunningHubLanguageCatalog(CATALOG);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.models.map(model => model.id)).toEqual(["glm/glm-5.2", "openai/vision"]);
    expect(parsed.models[0]).toMatchObject({
      id: "glm/glm-5.2",
      contextLength: 1_000_000,
      capabilities: { tools: true, vision: false, streaming: true, reasoning: true }
    });
    expect(parsed.models[1]!.capabilities).toMatchObject({ tools: false, vision: true, streaming: true, reasoning: false });
    expect(runningHubLanguageDefinitions(parsed.models).map(model => model.providerModelId)).toEqual([
      "llm/glm/glm-5.2",
      "llm/openai/vision"
    ]);
    expect(runningHubLanguageDefinitions(parsed.models)[0]!.capabilityFacts).toEqual({ reasoning: { supported: true } });
  });

  it("结构非法或空目录整份拒绝", () => {
    expect(parseRunningHubLanguageCatalog({})).toMatchObject({ ok: false });
    expect(parseRunningHubLanguageCatalog({ data: [] })).toMatchObject({ ok: false });
    expect(parseRunningHubLanguageCatalog({ data: [{ id: "x", capabilities: { chat: false } }] })).toMatchObject({ ok: false });
  });

  it("刷新失败保留上一次成功目录；成功才原子替换", async () => {
    resetRunningHubLanguageModels();
    const before = languageCatalog().map(model => model.id);
    const failed = await discoverRunningHubLanguageModels({
      fetchImpl: (async () => new Response("boom", { status: 500 })) as unknown as typeof globalThis.fetch
    });
    expect(failed).toMatchObject({ ok: false });
    expect(languageCatalog().map(model => model.id)).toEqual(before);

    const models = parseRunningHubLanguageCatalog(CATALOG);
    if (!models.ok) throw new Error(models.message);
    setRunningHubLanguageModels(models.models);
    expect(languageCatalog().map(model => model.id)).toEqual(["glm/glm-5.2", "openai/vision"]);
    expect(runningHubLanguageCapabilities("llm/openai/vision")).toEqual({ tools: false, imageInput: true, streaming: true });
    expect(runningHubLanguageCapabilities("llm/missing")).toBeUndefined();
    resetRunningHubLanguageModels();
  });
});
