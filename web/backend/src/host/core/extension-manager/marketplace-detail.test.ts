/** 市场版本详情（change: 2026-10-21-add-server-extension-marketplace，tasks 7.4）。 */
import { describe, expect, it } from "vitest";
import type { MarketplaceSource, MarketplaceSourceDetails } from "@woohaa3/contracts";
import { createMarketplaceRegistry } from "../marketplace.js";
import { createVersionStatusCache, managedVersionStatus, marketplaceExtensionDetail } from "./marketplace-detail.js";

const signal = new AbortController().signal;
const ENGINES = { hostAbi: "^1.0.0", sdkAbi: "^1.0.0", protocolVersion: 1 };

function source(overrides: Partial<MarketplaceSource & MarketplaceSourceDetails> = {}): MarketplaceSource & MarketplaceSourceDetails {
  return {
    sourceId: "woohaa-server",
    label: "团队市场",
    available: () => ({ ok: true }),
    search: async () => ({ items: [] }),
    resolve: async () => null,
    download: async () => {
      throw new Error("unused");
    },
    getExtension: async (id) =>
      id === "demo"
        ? {
            extensionId: "demo",
            label: "Demo",
            versions: [
              { version: "1.0.0", packageDigest: "sha256:a", size: 1, keyId: "trusted1", engines: ENGINES },
              { version: "1.1.0", packageDigest: "sha256:b", size: 2, keyId: "unknown2", engines: ENGINES }
            ]
          }
        : null,
    signingKeys: async () => [
      { keyId: "trusted1", label: "团队", publicKey: "PUB1" },
      { keyId: "unknown2", publicKey: "PUB2" }
    ],
    ...overrides
  };
}

function deps(
  registered: MarketplaceSource | null,
  trusted: Array<{ keyId?: string; publicKey: string }> = [{ publicKey: "PUB1" }],
  installed = "1.0.0",
  kind: "builtin" | "managed" = "managed"
) {
  const marketplace = createMarketplaceRegistry();
  if (registered) marketplace.register(registered);
  return {
    marketplace,
    trustedKeys: () => trusted as never,
    keyIdOf: (publicKey: string) => (publicKey === "PUB1" ? "trusted1" : null),
    installedVersion: (id: string) => (id === "demo" ? installed : undefined),
    installedKind: (id: string) => (id === "demo" ? kind : undefined)
  };
}

describe("marketplaceExtensionDetail", () => {
  it("合并版本列表、本机信任状态与已装版本；只信任本机配置的 keyId", async () => {
    const view = await marketplaceExtensionDetail(deps(source()), { sourceId: "woohaa-server", extensionId: "demo" }, signal);
    expect(view.extension.versions.map((entry) => entry.version)).toEqual(["1.0.0", "1.1.0"]);
    expect(view.trustedKeyIds).toEqual(["trusted1"]);
    expect(view.signingKeys).toEqual([
      { keyId: "trusted1", label: "团队", publicKey: "PUB1", trusted: true },
      { keyId: "unknown2", publicKey: "PUB2", trusted: false }
    ]);
    expect(view.installedVersion).toBe("1.0.0");
    expect(view.installedKind).toBe("managed");
    expect(view.latestVersion).toBe("1.1.0");
    expect(view.updateAvailable).toBe(true);
  });

  it("内置版本也参与比较：市场版本更高时给可升级提示，不改变信任判定", async () => {
    const view = await marketplaceExtensionDetail(deps(source(), undefined, "1.0.0", "builtin"), { sourceId: "woohaa-server", extensionId: "demo" }, signal);
    expect(view.installedKind).toBe("builtin");
    expect(view.updateAvailable).toBe(true);
    expect(view.latestVersion).toBe("1.1.0");
  });

  it("本机版本已是最高 → 不提示升级", async () => {
    const view = await marketplaceExtensionDetail(deps(source(), undefined, "1.1.0", "builtin"), { sourceId: "woohaa-server", extensionId: "demo" }, signal);
    expect(view.updateAvailable).toBeUndefined();
  });

  it("本机信任根带显式 keyId 也识别", async () => {
    const view = await marketplaceExtensionDetail(deps(source(), [{ keyId: "unknown2", publicKey: "x" }]), { sourceId: "woohaa-server", extensionId: "demo" }, signal);
    expect(view.trustedKeyIds).toEqual(["unknown2"]);
  });

  it("来源不存在 / 不提供详情 / 不可用 → MARKETPLACE_SOURCE_UNAVAILABLE；扩展不存在 → MARKETPLACE_SOURCE_NOT_FOUND", async () => {
    await expect(marketplaceExtensionDetail(deps(null), { sourceId: "woohaa-server", extensionId: "demo" }, signal)).rejects.toMatchObject({ code: "MARKETPLACE_SOURCE_UNAVAILABLE" });
    await expect(marketplaceExtensionDetail(deps(source({ getExtension: undefined })), { sourceId: "woohaa-server", extensionId: "demo" }, signal)).rejects.toMatchObject({ code: "MARKETPLACE_SOURCE_UNAVAILABLE" });
    await expect(marketplaceExtensionDetail(deps(source({ available: () => ({ ok: false, reason: "未登录" }) })), { sourceId: "woohaa-server", extensionId: "demo" }, signal)).rejects.toMatchObject({ code: "MARKETPLACE_SOURCE_UNAVAILABLE", message: "未登录" });
    await expect(marketplaceExtensionDetail(deps(source()), { sourceId: "woohaa-server", extensionId: "missing" }, signal)).rejects.toMatchObject({ code: "MARKETPLACE_SOURCE_NOT_FOUND" });
  });

  it("发布公钥读取失败不影响版本列表", async () => {
    const view = await marketplaceExtensionDetail(deps(source({ signingKeys: async () => { throw new Error("x"); } })), { sourceId: "woohaa-server", extensionId: "demo" }, signal);
    expect(view.signingKeys).toEqual([]);
    expect(view.extension.versions).toHaveLength(2);
  });
});

describe("managedVersionStatus（已撤回提示）", () => {
  const input = { sourceId: "woohaa-server", extensionId: "demo", version: "1.0.0" };
  const withVersions = (versions: Array<Record<string, unknown>>) =>
    source({ getExtension: async () => ({ extensionId: "demo", label: "Demo", versions: versions as never }) });
  const status = (s: MarketplaceSource | null) => managedVersionStatus(deps(s), input, signal, () => new Date("2026-10-21T00:00:00Z"));

  it("来源点名返回 YANKED + 原因 → withdrawn；带出最高可用版本", async () => {
    let asked: readonly string[] | undefined;
    const s = source({
      getExtension: async (_id, _signal, include) => {
        asked = include;
        return {
          extensionId: "demo",
          label: "Demo",
          versions: [
            { version: "1.1.0", packageDigest: "b", size: 1, state: "RELEASE_STATE_APPROVED" },
            { version: "1.0.0", packageDigest: "a", size: 1, state: "RELEASE_STATE_YANKED", yankReason: "安全问题" }
          ]
        };
      }
    });
    expect(await status(s)).toEqual({ ...input, status: "withdrawn", reason: "安全问题", latest: "1.1.0", checkedAt: "2026-10-21T00:00:00.000Z" });
    expect(asked).toEqual(["1.0.0"]);
  });

  it("旧服务端只回已审核版本：已装版本不在列表 → withdrawn（无原因）；仍在 → available", async () => {
    expect((await status(withVersions([{ version: "1.1.0", packageDigest: "b", size: 1, state: "RELEASE_STATE_APPROVED" }]))).status).toBe("withdrawn");
    const ok = await status(withVersions([{ version: "1.0.0", packageDigest: "a", size: 1, state: "RELEASE_STATE_APPROVED" }]));
    expect(ok).toMatchObject({ status: "available", latest: "1.0.0" });
    expect(ok.reason).toBeUndefined();
  });

  it("来源不存在 / 不可用 / 查询抛错 / 扩展整体不在 → unknown（不显示）", async () => {
    expect((await status(null)).status).toBe("unknown");
    expect((await status(source({ available: () => ({ ok: false, reason: "x" }) }))).status).toBe("unknown");
    expect((await status(source({ getExtension: async () => { throw new Error("boom"); } }))).status).toBe("unknown");
    expect((await status(source({ getExtension: async () => null }))).status).toBe("unknown");
  });

  it("缓存：TTL 内复用、并发合并；unknown 不缓存", async () => {
    let calls = 0;
    let next: "withdrawn" | "unknown" = "withdrawn";
    let clock = 0;
    const cached = createVersionStatusCache(async () => {
      calls += 1;
      return { ...input, status: next, checkedAt: "t" };
    }, { ttlMs: 1000, now: () => clock });
    await Promise.all([cached(input), cached(input)]);
    expect(calls).toBe(1);
    clock = 999;
    await cached(input);
    expect(calls).toBe(1);
    clock = 1000;
    next = "unknown";
    await cached(input);
    await cached(input);
    expect(calls).toBe(3);
  });
});
