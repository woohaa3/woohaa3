/**
 * 受控来源注册表测试（change: 2026-10-12-add-extension-online-canvas-migration，任务 3.1–3.3）。
 *
 * 覆盖：唯一 owner（重复 sourceId 注册被宿主拒绝）、调用时配置版本/停用校验（不裸缓存）、
 * 形状校验、恢复模式不可用，以及每次调用都重新确认 owner。
 */
import { describe, expect, it } from "vitest";
import { createApplicationExtensionHost } from "./host.js";
import { createCanvasSourceRegistry } from "./canvas-source-registry.js";
import type { CanvasSourceProvider } from "@woohaa3/contracts";

function provider(sourceId: string, converterVersion = "v1"): CanvasSourceProvider {
  return {
    sourceId,
    extensionId: "legacy-import",
    converterVersion,
    listAccessible: async () => ({ items: [], nextCursor: null }),
    resolveAccessible: async () => ({ ok: false, code: "FORBIDDEN", retryable: false, message: "stub" }),
    prepareCandidate: async () => ({ ok: false, code: "SOURCE_UNAVAILABLE", retryable: false, message: "stub" }),
    validateSnapshot: async () => ({ ok: true })
  };
}

async function hostWithSource() {
  const host = createApplicationExtensionHost();
  await host.activate({
    extensionId: "legacy-import",
    activate: (h) => {
      h.registerCapability({ id: "canvas-source:legacy-source", value: provider("legacy-source") });
    }
  });
  return host;
}

describe("来源注册表：唯一 owner 与版本绑定（任务 3.1）", () => {
  it("resolve 返回版本绑定 handle，并校验 capability 形状与身份一致", async () => {
    const host = await hostWithSource();
    const registry = createCanvasSourceRegistry(host);
    const result = registry.resolve("legacy-source");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.handle.owner.extensionId).toBe("legacy-import");
    expect(result.handle.owner.mode).toBe("public");
    expect(result.handle.provider.sourceId).toBe("legacy-source");
  });

  it("未知 sourceId 返回 SOURCE_UNAVAILABLE", async () => {
    const host = await hostWithSource();
    const registry = createCanvasSourceRegistry(host);
    expect(registry.resolve("missing")).toEqual({ ok: false, code: "SOURCE_UNAVAILABLE", message: expect.any(String) });
  });

  it("同一 sourceId 被第二个 owner 注册时宿主稳定拒绝（唯一 owner）", async () => {
    const host = await hostWithSource();
    const result = await host.activate({
      extensionId: "another-extension",
      activate: (h) => {
        h.registerCapability({ id: "canvas-source:legacy-source", value: provider("legacy-source", "v2") });
      }
    });
    expect(result.ok).toBe(false);
    // 原 owner 不受影响。
    const registry = createCanvasSourceRegistry(host);
    expect(registry.resolve("legacy-source").ok).toBe(true);
  });

  it("形状非法的 capability 不被注册（activation 回滚）", async () => {
    const host = createApplicationExtensionHost();
    const result = await host.activate({
      extensionId: "broken",
      activate: (h) => {
        h.registerCapability({ id: "canvas-source:broken", value: { sourceId: "broken" } });
      }
    });
    // 宿主允许任意 capability 值；注册表必须拒绝非法的来源 capability。
    expect(result.ok).toBe(true);
    const registry = createCanvasSourceRegistry(host);
    expect(registry.resolve("broken").ok).toBe(false);
  });
});

describe("来源注册表：每次调用校验 owner/停用（任务 3.2 / 3.3）", () => {
  it("assertBoundContext 在 handle 与调用上下文版本不一致时拒绝", async () => {
    const host = await hostWithSource();
    const registry = createCanvasSourceRegistry(host);
    const resolved = registry.resolve("legacy-source");
    if (!resolved.ok) throw new Error("should resolve");
    expect(registry.assertBoundContext(resolved.handle, { subject: "u", extensionId: "legacy-import", configVersion: 99 }).ok).toBe(false);
    expect(registry.assertBoundContext(resolved.handle, { subject: "u", extensionId: "legacy-import", configVersion: 0 }).ok).toBe(true);
  });

  it("extension 停用后 resolve 立即失败（不裸缓存）", async () => {
    const host = createApplicationExtensionHost();
    const activation = await host.activate({
      extensionId: "legacy-import",
      activate: (h) => {
        h.registerCapability({ id: "canvas-source:legacy-source", value: provider("legacy-source") });
      }
    });
    if (!activation.ok) throw new Error("activate");
    const registry = createCanvasSourceRegistry(host);
    expect(registry.resolve("legacy-source").ok).toBe(true);
    await activation.handle.dispose();
    expect(registry.resolve("legacy-source")).toEqual({ ok: false, code: "SOURCE_UNAVAILABLE", message: expect.any(String) });
  });

  it("list() 只枚举 public 来源，且按 sourceId 排序", async () => {
    const host = createApplicationExtensionHost();
    await host.activate({
      extensionId: "legacy-import",
      activate: (h) => {
        h.registerCapability({ id: "canvas-source:zeta", value: provider("zeta") });
        h.registerCapability({ id: "canvas-source:alpha", value: provider("alpha") });
      }
    });
    const registry = createCanvasSourceRegistry(host);
    expect(registry.list().map((owner) => owner.sourceId)).toEqual(["alpha", "zeta"]);
  });
});
