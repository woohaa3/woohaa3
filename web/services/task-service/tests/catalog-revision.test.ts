/**
 * 任务目录修订（catalogRevision）：轻量读取 + Provider catalogRevision 参与生成签名
 * （change: 2026-10-20-reserve-remote-generation-provider，任务 3.2/3.3）。
 *
 * 目标：
 * 1. `catalogRevision()` 不构建完整 catalog（不调 Provider describe），但签名变化时推进 revision；
 * 2. 远端 Provider 只改 catalogRevision / 模型描述、不改 id 集合时，目录也必须失效；
 * 3. 轻量读与 `resolveCatalog()` 共用同一 bump 逻辑，不重复推进。
 */
import { describe, expect, it } from "vitest";
import type { GenerationProvider } from "@woohaa3/contracts";
import { createCatalogRuntime } from "../src/composition/catalog-runtime.js";

function provider(described: { count: number }, models: GenerationProvider["models"] = []): GenerationProvider {
  return {
    extensionId: "remote-server",
    providerId: "remote-server",
    available: true,
    selectionAuthority: "server",
    provider: {} as never,
    models: [
      {
        providerId: "remote-server",
        providerModelId: "image-1",
        modelType: "image",
        title: "远端图片"
      },
      ...models
    ],
    describeModel: async () => {
      described.count += 1;
      return { inputSchema: { type: "object", properties: { prompt: { type: "string" } } } };
    }
  };
}

function runtimeFor(providers: GenerationProvider[]) {
  return createCatalogRuntime({
    generationProviders: () => providers,
    modelsConfig: { version: 1, models: [] },
    resolveModelSelection: (registry) => ({
      ok: true,
      models: registry.map((entry, index) => ({
        modelKey: entry.modelKey,
        providerId: entry.providerId,
        providerModelId: entry.providerModelId,
        modelType: entry.modelType,
        order: index,
        isDefault: false
      })),
      defaults: {}
    })
  });
}

describe("catalogRevision 轻量读取", () => {
  it("不构建 catalog，只在签名变化时前进", () => {
    const described = { count: 0 };
    const first = provider(described);
    const providers = [first];
    const runtime = runtimeFor(providers);

    expect(runtime.catalogRevision()).toBe(1);
    expect(described.count).toBe(0);

    // 签名未变：不前进。
    expect(runtime.catalogRevision()).toBe(1);

    // 模型 id 集合变化：前进。
    first.models.push({ providerId: "remote-server", providerModelId: "video-1", modelType: "video" });
    expect(runtime.catalogRevision()).toBe(2);

    // Provider catalogRevision 变化（id 集合与 capabilityFacts 都不变）：前进。
    first.catalogRevision = 7;
    expect(runtime.catalogRevision()).toBe(3);

    // 依然是轻量读。
    expect(described.count).toBe(0);
  });
});

describe("catalogRevision 与目录构建共享 bump", () => {
  it("轻量读先推进后，resolveCatalog 不重复推进", async () => {
    const described = { count: 0 };
    const runtime = runtimeFor([provider(described)]);

    expect(runtime.catalogRevision()).toBe(1);
    const catalog = await runtime.resolveCatalog();
    expect(catalog.catalogRevision).toBe(1);
    expect(described.count).toBe(1);
    expect(runtime.catalogRevision()).toBe(1);
  });

  it("描述变化（Provider catalogRevision 前进）使已构建目录失效重算", async () => {
    const described = { count: 0 };
    const first = provider(described);
    const runtime = runtimeFor([first]);

    const before = await runtime.resolveCatalog();
    expect(before.available).toBe(true);
    expect(before.catalogRevision).toBe(1);

    // 只改版本号、不改模型 id：目录必须重算（远端 Provider 刷新 schema/能力时就是这个形状）。
    first.catalogRevision = 2;
    const after = await runtime.resolveCatalog();
    expect(after.catalogRevision).toBe(2);
    expect(described.count).toBe(2);
  });
});
