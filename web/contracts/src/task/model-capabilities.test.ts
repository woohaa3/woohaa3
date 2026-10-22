/**
 * 模型事实能力契约（change: 2026-10-20-declare-generation-model-capabilities）。
 *
 * 覆盖：形状校验（只认已知字段、非法丢整条）、目录派生读取（inputs 由 bindings 派生、
 * reasoning 由事实派生）、缺省语义（未声明 = 不支持）。
 */
import { describe, expect, it } from "vitest";
import { canvasModelCapabilities, isGenerationModelCapabilityFacts } from "./model-capabilities.js";
import { normalizeInputBindings, type CanvasTaskCatalogModel } from "./dto.js";

function catalogModel(overrides: Partial<CanvasTaskCatalogModel> = {}): CanvasTaskCatalogModel {
  return {
    modelKey: "text-provider:chat",
    providerId: "text-provider",
    providerModelId: "chat",
    modelType: "language",
    title: "chat",
    interaction: { id: "generic", version: 1 },
    inputSchema: {},
    defaultInput: {},
    bindings: [],
    taskTimeoutMs: 1000,
    ...overrides
  };
}

describe("isGenerationModelCapabilityFacts", () => {
  it("接受已知字段的合法形状（未知字段忽略）", () => {
    expect(isGenerationModelCapabilityFacts({})).toBe(true);
    expect(isGenerationModelCapabilityFacts({ reasoning: { supported: true } })).toBe(true);
    expect(isGenerationModelCapabilityFacts({ reasoning: { supported: true, efforts: ["low", "high"] } })).toBe(true);
    expect(isGenerationModelCapabilityFacts({ reasoning: { supported: true, efforts: [] } })).toBe(true);
    expect(isGenerationModelCapabilityFacts({ reasoning: { supported: true }, future: 1 })).toBe(true);
  });

  it("拒绝非法形状（目录据此整体丢弃该字段）", () => {
    expect(isGenerationModelCapabilityFacts(undefined)).toBe(false);
    expect(isGenerationModelCapabilityFacts(null)).toBe(false);
    expect(isGenerationModelCapabilityFacts([])).toBe(false);
    expect(isGenerationModelCapabilityFacts({ reasoning: true })).toBe(false);
    expect(isGenerationModelCapabilityFacts({ reasoning: {} })).toBe(false);
    expect(isGenerationModelCapabilityFacts({ reasoning: { supported: "yes" } })).toBe(false);
    expect(isGenerationModelCapabilityFacts({ reasoning: { supported: true, efforts: "low" } })).toBe(false);
    expect(isGenerationModelCapabilityFacts({ reasoning: { supported: true, efforts: [""] } })).toBe(false);
  });
});

describe("canvasModelCapabilities", () => {
  it("inputs 由 bindings 派生（不复制第二份开关）", () => {
    const model = catalogModel({
      bindings: normalizeInputBindings([{ field: "urls", semantic: "reference-image", maxItems: 4 }])
    });

    expect(canvasModelCapabilities(model).inputs).toEqual({ image: true, video: false, audio: false });
  });

  it("无 bindings 时三种媒体均为 false", () => {
    expect(canvasModelCapabilities(catalogModel()).inputs).toEqual({ image: false, video: false, audio: false });
  });

  it("reasoning 取声明的事实；缺省不出现", () => {
    expect(canvasModelCapabilities(catalogModel()).reasoning).toBeUndefined();
    const declared = canvasModelCapabilities(catalogModel({
      capabilityFacts: { reasoning: { supported: true, efforts: ["low", "high"] } }
    }));
    expect(declared.reasoning).toEqual({ supported: true, efforts: ["low", "high"] });
  });

  it("非法事实按未声明处理（消费者只看得到 bindings 派生结果）", () => {
    const model = catalogModel({
      bindings: normalizeInputBindings([{ field: "urls", semantic: "reference-image", maxItems: 4 }]),
      capabilityFacts: { reasoning: { supported: "yes" } } as never
    });

    const capabilities = canvasModelCapabilities(model);
    expect(capabilities.inputs).toEqual({ image: true, video: false, audio: false });
    expect(capabilities.reasoning).toBeUndefined();
  });
});
