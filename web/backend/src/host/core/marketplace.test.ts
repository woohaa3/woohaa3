import { describe, expect, it, vi } from "vitest";
import type { MarketplaceSource } from "@woohaa3/contracts";
import { createMarketplaceRegistry } from "./marketplace.js";

function source(sourceId: string): MarketplaceSource {
  return {
    sourceId,
    label: sourceId,
    available: () => ({ ok: true }),
    search: async () => ({ items: [] }),
    resolve: async () => null,
    download: async () => {
      throw new Error("not used");
    }
  };
}

describe("ctx.marketplace 注册表", () => {
  it("注册、列出、解析与注销", () => {
    const logger = vi.fn();
    const registry = createMarketplaceRegistry({ logger });
    const off = registry.register(source("woohaa-server"));
    registry.register(source("corp"));
    expect(registry.list().map((s) => s.sourceId)).toEqual(["woohaa-server", "corp"]);
    expect(registry.resolve("corp")?.sourceId).toBe("corp");
    off();
    expect(registry.resolve("woohaa-server")).toBeUndefined();
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({ event: "marketplace-source-unregistered", sourceId: "woohaa-server" }));
  });

  it("重复 sourceId 拒绝，且不覆盖已注册来源", () => {
    const registry = createMarketplaceRegistry();
    const first = source("a");
    registry.register(first);
    expect(() => registry.register(source("a"))).toThrow(expect.objectContaining({ code: "MARKETPLACE_SOURCE_DUPLICATE" }));
    expect(registry.resolve("a")).toBe(first);
  });

  it("旧注销函数不会撤掉同 id 的新来源（随 fiber 重启）", () => {
    const registry = createMarketplaceRegistry();
    const off = registry.register(source("a"));
    off();
    const next = source("a");
    registry.register(next);
    off();
    expect(registry.resolve("a")).toBe(next);
  });

  it("受管根或可写根插件注册来源被拒绝；内置根允许", () => {
    const registry = createMarketplaceRegistry();
    expect(() => registry.scoped({ managed: true, rootWritable: false }).register(source("evil"))).toThrow(
      expect.objectContaining({ code: "EXTENSION_MARKETPLACE_SOURCE_UNTRUSTED_ROOT" })
    );
    expect(() => registry.scoped({ managed: false, rootWritable: true }).register(source("evil2"))).toThrow(
      expect.objectContaining({ code: "EXTENSION_MARKETPLACE_SOURCE_UNTRUSTED_ROOT" })
    );
    expect(registry.list()).toEqual([]);
    registry.scoped({ managed: false, rootWritable: false }).register(source("ok"));
    expect(registry.resolve("ok")).toBeDefined();
  });

  it("扩展层插件缺少宿主 origin 时拒绝注册来源（D3：不靠缺省放行）", () => {
    const registry = createMarketplaceRegistry();
    expect(() => registry.scoped(undefined).register(source("anon"))).toThrow(
      expect.objectContaining({ code: "EXTENSION_MARKETPLACE_SOURCE_UNTRUSTED_ROOT" })
    );
    expect(registry.resolve("anon")).toBeUndefined();
  });

  it("形状不合法的来源被拒绝", () => {
    const registry = createMarketplaceRegistry();
    expect(() => registry.register({ ...source("x"), download: undefined } as never)).toThrow(expect.objectContaining({ code: "MARKETPLACE_SOURCE_INVALID" }));
    expect(() => registry.register(source("Bad Id"))).toThrow(expect.objectContaining({ code: "MARKETPLACE_SOURCE_INVALID" }));
  });
});
