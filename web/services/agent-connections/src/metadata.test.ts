import { describe, expect, it } from "vitest";
import { connectionModelCatalogRevision, mergeModelCapabilities, modelCatalogForRecord } from "./metadata.js";

describe("连接模型能力快照", () => {
  it("旧 models 字符串读取为 unknown 且不伪造档位", () => {
    const catalog = modelCatalogForRecord({ models: ["deepseek-v4-pro", "gpt-5"], configRevision: 3 });
    expect(catalog.models.map((model) => model.id)).toEqual(["deepseek-v4-pro", "gpt-5"]);
    expect(catalog.models.every((model) => model.reasoning.state === "unknown")).toBe(true);
    expect(catalog.revision).toBe(connectionModelCatalogRevision(catalog.models));
  });

  it("纯 id 输入保留同 id 的已知能力，目录顺序不推进修订号", () => {
    const previous = {
      revision: "r",
      capturedAt: "now",
      models: [
        { id: "a", reasoning: { state: "supported" as const, source: "provider" as const, revision: "r", efforts: [{ id: "low" as const }] } },
        { id: "b", reasoning: { state: "unsupported" as const, source: "provider" as const, revision: "r" } }
      ]
    };
    const merged = mergeModelCapabilities(["a", "b", "c"], previous);
    expect(merged.map((model) => [model.id, model.reasoning.state])).toEqual([["a", "supported"], ["b", "unsupported"], ["c", "unknown"]]);
    expect(connectionModelCatalogRevision(merged)).toBe(connectionModelCatalogRevision([...merged].reverse()));
  });

  it("精确档位只保留输入里的可执行值", () => {
    const merged = mergeModelCapabilities([{
      id: "m",
      reasoning: { state: "supported", source: "provider", revision: "r", efforts: [{ id: "low" }, { id: "high" }] }
    }], undefined);
    expect(merged[0]?.reasoning.efforts?.map((option) => option.id)).toEqual(["low", "high"]);
  });
});
