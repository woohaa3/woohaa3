/**
 * 任务目录缓存：只改运营策略的启用集合时也要重算，否则新启用的模型进不了节点。
 */
import { describe, expect, it } from "vitest";
import { createCatalogRuntime } from "../src/composition/catalog-runtime.js";

const seedance = {
  extensionId: "ark-provider",
  providerId: "ark",
  available: true,
  provider: {},
  models: [{
    providerId: "ark",
    providerModelId: "doubao-seedance-2-0-260128",
    modelType: "video" as const,
    title: "Seedance 2.0",
    executable: true
  }],
  describeModel: async () => ({ inputSchema: { type: "object", properties: { prompt: { type: "string" } } } })
};

describe("catalog follows the model policy revision", () => {
  it("includes a model after it is enabled without a registry change", async () => {
    let enabled = false;
    let revision = 1;
    const runtime = createCatalogRuntime({
      generationProviders: () => [seedance],
      modelsConfig: { version: 1, models: [] },
      resolveModelSelection: () => ({
        ok: true,
        models: enabled
          ? [{
              modelKey: "ark:doubao-seedance-2-0-260128",
              providerId: "ark",
              providerModelId: "doubao-seedance-2-0-260128",
              modelType: "video",
              title: "Seedance 2.0",
              order: 0,
              isDefault: false
            }]
          : [],
        defaults: {}
      }),
      selectionStamp: () => String(revision)
    });

    const before = await runtime.resolveCatalog();
    expect(before.available).toBe(false);

    enabled = true;
    revision = 2;
    const after = await runtime.resolveCatalog();
    expect(after.available).toBe(true);
    if (!after.available) return;
    expect(after.models.map((model) => model.modelKey)).toEqual(["ark:doubao-seedance-2-0-260128"]);
  });
});
