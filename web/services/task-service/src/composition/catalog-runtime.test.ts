/**
 * Provider registry 缓存签名（change: 2026-11-16-repair-generation-callback-stalls，缺陷 3）。
 *
 * 真实缺陷：签名原本只含 providerId/available/catalogRevision/models。换 API Key 不改这些字段，
 * 于是 registry 命中缓存、继续返回**持旧 key 的实例**。表现最能骗人的是：配置显示已保存、
 * `testConnection`（现读配置）通过，真实生成却持续鉴权失败，只有重启进程才恢复
 * （2026-11-16 现场：RunningHub 同一个 key 重启前失败、重启后成功）。
 */
import { describe, expect, it } from "vitest";
import type { GenerationProvider, GenerationModelDefinition } from "@woohaa3/contracts";
import { createCatalogRuntime } from "./catalog-runtime.js";

const models: GenerationModelDefinition[] = [
  { providerId: "prov", providerModelId: "model-a", modelType: "image", title: "A" }
];

function provider(overrides: Partial<GenerationProvider> = {}): GenerationProvider {
  return {
    extensionId: "ext",
    providerId: "prov",
    available: true,
    provider: { handle: "instance" } as never,
    models,
    ...overrides
  } as GenerationProvider;
}

/**
 * `generationProviders` 是宿主插件热更新后重新读取的闭包；用可变数组模拟
 * 「同一 runtime、插件已重建实例」的场景。
 */
function runtimeOver(entries: GenerationProvider[]) {
  return createCatalogRuntime({
    generationProviders: () => entries,
    modelsConfig: { models: [], defaults: {} } as never
  });
}

describe("catalog runtime 的 provider 缓存签名", () => {
  it("凭据修订变化时重建 registry，换 key 立即用新实例", () => {
    const stale = { handle: "stale-key" };
    const fresh = { handle: "fresh-key" };
    const entries: GenerationProvider[] = [provider({ provider: stale as never, credentialEpoch: 1 })];
    const runtime = runtimeOver(entries);

    expect(runtime.registry().resolveProvider("prov")).toBe(stale as never);

    // 换 key：providerId/available/catalogRevision/models 全不变，只有 credentialEpoch 变化。
    entries[0] = provider({ provider: fresh as never, credentialEpoch: 2 });

    expect(runtime.registry().resolveProvider("prov")).toBe(fresh as never);
  });

  it("只有凭据修订不同、其余签名要素完全一致时也必须失效", () => {
    const entries: GenerationProvider[] = [provider({ provider: { v: 1 } as never, credentialEpoch: 10 })];
    const runtime = runtimeOver(entries);
    const first = runtime.registry();

    entries[0] = provider({ provider: { v: 2 } as never, credentialEpoch: 11 });

    expect(runtime.registry()).not.toBe(first);
    expect(runtime.registry().resolveProvider("prov")).toEqual({ v: 2 });
  });

  it("未声明凭据修订时签名保持稳定，不无谓重建", () => {
    const entries: GenerationProvider[] = [provider()];
    const runtime = runtimeOver(entries);
    const first = runtime.registry();
    expect(runtime.registry()).toBe(first);
    expect(runtime.registry()).toBe(first);
  });
});
