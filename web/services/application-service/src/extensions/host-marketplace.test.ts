/**
 * 站点扩展的市场来源接缝（change: 2026-10-21-add-server-extension-marketplace，tasks 7.1 / design D6）。
 */
import { describe, expect, it } from "vitest";
import type { MarketplaceSource } from "@woohaa3/contracts";
import { createApplicationExtensionHost } from "./host.js";

function source(sourceId: string): MarketplaceSource {
  return {
    sourceId,
    label: sourceId,
    available: () => ({ ok: true }),
    search: async () => ({ items: [] }),
    resolve: async () => null,
    download: async () => {
      throw new Error("unused");
    }
  };
}

/** 模拟 core 的 scoped 断言：只有列入 builtin 的扩展可以注册。 */
function fakeCore(builtin: readonly string[]) {
  const sources = new Map<string, MarketplaceSource>();
  const released: string[] = [];
  return {
    sources,
    released,
    options: {
      registerMarketplaceSourceFor: (extensionId: string) => (registration: MarketplaceSource) => {
        if (!builtin.includes(extensionId)) {
          throw Object.assign(new Error(`市场来源 ${registration.sourceId} 来自受管根`), { code: "EXTENSION_MARKETPLACE_SOURCE_UNTRUSTED_ROOT" });
        }
        if (sources.has(registration.sourceId)) throw new Error("dup");
        sources.set(registration.sourceId, registration);
      },
      releaseMarketplaceSourceFor: () => (sourceId: string) => {
        released.push(sourceId);
        sources.delete(sourceId);
      }
    }
  };
}

describe("host.registerMarketplaceSource", () => {
  it("内置根站点扩展注册来源；停用时按反序注销", async () => {
    const core = fakeCore(["remote-server"]);
    const host = createApplicationExtensionHost(core.options);
    const result = await host.activate({
      extensionId: "remote-server",
      activate: (h) => {
        h.registerMarketplaceSource!(source("woohaa-server"));
        h.registerMarketplaceSource!(source("woohaa-server-mirror"));
      }
    });
    expect(result.ok).toBe(true);
    expect([...core.sources.keys()]).toEqual(["woohaa-server", "woohaa-server-mirror"]);
    if (!result.ok) return;
    await result.handle.dispose();
    expect(core.released).toEqual(["woohaa-server-mirror", "woohaa-server"]);
    expect(core.sources.size).toBe(0);
  });

  it("可写根 / 受管根站点扩展注册被拒：activation 失败，来源不出现", async () => {
    const core = fakeCore([]);
    const host = createApplicationExtensionHost(core.options);
    const result = await host.activate({
      extensionId: "untrusted-site",
      activate: (h) => {
        h.registerMarketplaceSource!(source("evil"));
      }
    });
    expect(result.ok).toBe(false);
    expect(core.sources.size).toBe(0);
    expect(core.released).toEqual([]);
  });

  it("显式注销后回滚不重复注销", async () => {
    const core = fakeCore(["remote-server"]);
    const host = createApplicationExtensionHost(core.options);
    const result = await host.activate({
      extensionId: "remote-server",
      activate: (h) => {
        h.registerMarketplaceSource!(source("woohaa-server"));
        h.unregisterMarketplaceSource!("woohaa-server");
      }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await result.handle.dispose();
    expect(core.released).toEqual(["woohaa-server"]);
  });

  it("宿主没有市场扩展点时插件拿不到 registerMarketplaceSource", async () => {
    const host = createApplicationExtensionHost();
    let seen = true;
    const result = await host.activate({
      extensionId: "remote-server",
      activate: (h) => {
        seen = h.registerMarketplaceSource !== undefined;
      }
    });
    expect(result.ok).toBe(true);
    expect(seen).toBe(false);
  });
});
