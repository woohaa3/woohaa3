/** 站点扩展来源断言（change: 2026-10-21-add-server-extension-marketplace，tasks 7.1）。 */
import { describe, expect, it } from "vitest";
import type { MarketplaceSource } from "@woohaa3/contracts";
import { siteExtensionOrigin } from "./application.js";
import { createMarketplaceRegistry } from "./marketplace.js";

const source = (sourceId: string): MarketplaceSource => ({
  sourceId,
  label: sourceId,
  available: () => ({ ok: true }),
  search: async () => ({ items: [] }),
  resolve: async () => null,
  download: async () => {
    throw new Error("unused");
  }
});

describe("siteExtensionOrigin + ctx.marketplace.scoped", () => {
  const host = {
    registrations: [
      { extensionId: "remote-server", managed: false, rootWritable: false },
      { extensionId: "writable-site", managed: false, rootWritable: true },
      { extensionId: "managed-site", managed: true, rootWritable: false }
    ]
  };

  it("内置根站点扩展可以注册", () => {
    const registry = createMarketplaceRegistry();
    registry.scoped(siteExtensionOrigin(host, "remote-server")).register(source("woohaa-server"));
    expect(registry.resolve("woohaa-server")).toBeDefined();
  });

  it("可写根、受管根与未扫描的扩展注册被拒", () => {
    const registry = createMarketplaceRegistry();
    for (const id of ["writable-site", "managed-site", "unknown"]) {
      expect(() => registry.scoped(siteExtensionOrigin(host, id)).register(source(`s-${id}`))).toThrow(
        expect.objectContaining({ code: "EXTENSION_MARKETPLACE_SOURCE_UNTRUSTED_ROOT" })
      );
    }
    expect(registry.list()).toEqual([]);
    expect(siteExtensionOrigin(undefined, "remote-server")).toBeUndefined();
  });
});
