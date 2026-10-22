/**
 * catalog 对能力事实的归一（change: 2026-10-20-declare-generation-model-capabilities）。
 *
 * 合法事实透传；非法形状整体丢弃且不影响可执行性与 bindings；缺省不出现。
 */
import { describe, expect, it } from "vitest";
import type { GenerationModelCapabilityFacts } from "@woohaa3/contracts";
import { buildCanvasTaskCatalog } from "../src/catalog/build-catalog.js";
import type { DescribedModel, TaskCatalogProvider } from "../src/catalog/types.js";
import type { ModelsConfig } from "../src/config/models-config.js";

const MODELS: ModelsConfig = { version: 1, models: [] };

function providerDescribing(described: DescribedModel): TaskCatalogProvider {
  return {
    listModels: () => [
      { modelKey: "text-provider:chat", providerId: "text-provider", providerModelId: "chat", modelType: "language" }
    ],
    describe: async () => described
  };
}

const BASE: DescribedModel = {
  providerId: "text-provider",
  modelId: "chat",
  modelType: "language",
  title: "chat",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string" },
      urls: { type: "array", "x-pptask-semantic": "reference-image", maxItems: 4 }
    }
  },
  defaultInput: {}
};

async function catalogFor(capabilityFacts: unknown) {
  const described = { ...BASE, capabilityFacts } as DescribedModel;
  const catalog = await buildCanvasTaskCatalog(providerDescribing(described), MODELS);
  expect(catalog.available, catalog.reason ?? "").toBe(true);
  const model = catalog.models[0];
  if (!model) throw new Error("catalog 缺少模型");
  return model;
}

describe("catalog 能力事实归一", () => {
  it("合法事实原样透传", async () => {
    const facts: GenerationModelCapabilityFacts = { reasoning: { supported: true, efforts: ["low", "high"] } };
    const model = await catalogFor(facts);
    expect(model.capabilityFacts).toEqual(facts);
  });

  it("缺省时不出现（消费者按未声明处理）", async () => {
    const model = await catalogFor(undefined);
    expect(model.capabilityFacts).toBeUndefined();
  });

  it("非法形状整体丢弃，且不影响 bindings 与其它字段", async () => {
    const model = await catalogFor({ reasoning: { supported: "yes" } });
    expect(model.capabilityFacts).toBeUndefined();
    expect(model.bindings).toHaveLength(1);
    expect(model.bindings[0]?.mediaKinds).toEqual(["image"]);
    expect(model.inputSchema).toEqual(BASE.inputSchema);
  });
});
