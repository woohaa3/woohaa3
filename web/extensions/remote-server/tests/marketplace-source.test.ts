/**
 * 「本部署市场」来源的单测（change: 服务端扩展市场，客户端接入）。
 *
 * 只测映射与门控，不碰网络：Connect 调用由 `call` 注入。
 */
import { describe, expect, it, vi } from "vitest";
import {
  createServerMarketplaceSource,
  registerServerMarketplaceSource
} from "../src/backend/marketplace/register.js";
import type { MarketplaceSource } from "@woohaa3/contracts";
import type { RemoteSession } from "../src/backend/session.js";

const SESSION: RemoteSession = {
  serverUrl: "https://server.example",
  token: "token-1",
  subject: "ops-admin",
  displayName: null,
  expiresAt: Date.now() + 3_600_000
};

function sourceWith(handlers: Record<string, unknown>, session: RemoteSession | null = SESSION) {
  const calls: Array<{ procedure: string; body: unknown }> = [];
  const source = createServerMarketplaceSource({
    currentSession: async () => session,
    fetchImpl: (() => Promise.reject(new Error("不该发真实请求"))) as unknown as typeof globalThis.fetch,
    call: async <T>(_session: RemoteSession, procedure: string, body: unknown) => {
      calls.push({ procedure, body });
      const key = Object.keys(handlers).find((name) => procedure.endsWith(name));
      if (!key) return { ok: true as const, value: {} as T };
      const value = handlers[key];
      return typeof value === "function"
        ? (value as (body: unknown) => { ok: true; value: T } | { ok: false; status: number; code: string; message: string })(body)
        : { ok: true as const, value: value as T };
    }
  });
  source.setSession(session);
  return { source, calls };
}

const APPROVED = "RELEASE_STATE_APPROVED";

describe("本部署市场来源", () => {
  it("没有会话时不可用，且给出可照做的原因", () => {
    const { source } = sourceWith({}, null);
    expect(source.available()).toEqual({ ok: false, reason: "未连接服务端（先在「服务端接入」里登录）" });
  });

  it("有会话时可用；搜索把 summary 映射成目录条目并透传分页游标", async () => {
    const { source, calls } = sourceWith({
      SearchExtensions: {
        extensions: [
          { extensionId: "film-set", label: "片场", description: "3D", latestVersion: "1.2.3", icon: "cube" },
          { extensionId: "broken" }
        ],
        nextPageToken: "cursor-2"
      }
    });
    expect(source.available()).toEqual({ ok: true });

    const page = await source.search({ text: "片", limit: 10 }, new AbortController().signal);
    expect(page.items).toEqual([
      { extensionId: "film-set", label: "片场", latest: "1.2.3", description: "3D", icon: "cube" }
    ]);
    expect(page.nextCursor).toBe("cursor-2");
    expect(calls[0]).toMatchObject({ procedure: "/woohaa.marketplace.v1alpha1.MarketplaceService/SearchExtensions" });
    expect(calls[0]?.body).toEqual({ text: "片", pageSize: 10 });
  });

  it("resolve 只挑 approved 版本，按 semver range 取最高", async () => {
    const { source } = sourceWith({
      GetExtension: {
        extension: { extensionId: "film-set", label: "片场" },
        versions: [
          { version: "1.0.0", packageDigest: "sha256:aa", size: "100", state: APPROVED, engines: { hostAbi: "^1", sdkAbi: "^1", protocolVersion: 1 } },
          // 已撤回：即使 range 命中也不能装
          { version: "1.1.0", packageDigest: "sha256:bb", size: "110", state: "RELEASE_STATE_YANKED" },
          { version: "1.2.0", packageDigest: "sha256:cc", size: "120", state: APPROVED, keyId: "k1", engines: { hostAbi: "^1", sdkAbi: "^1", protocolVersion: 1 } }
        ]
      }
    });

    const ref = await source.resolve("film-set", "^1.0.0", new AbortController().signal);
    expect(ref).toMatchObject({
      sourceId: "woohaa-server",
      extensionId: "film-set",
      version: "1.2.0",
      packageDigest: "sha256:cc",
      size: 120,
      engines: { hostAbi: "^1", sdkAbi: "^1", protocolVersion: 1 }
    });

    const none = await source.resolve("film-set", "^2.0.0", new AbortController().signal);
    expect(none).toBeNull();
  });

  it("详情把 state / yankReason / publishedAt 一并带回（撤回提示要用）", async () => {
    const { source } = sourceWith({
      GetExtension: {
        extension: { extensionId: "film-set", label: "片场" },
        versions: [
          { version: "1.0.0", packageDigest: "sha256:aa", size: 1, state: APPROVED, publishedAt: "2026-10-01T00:00:00Z" },
          { version: "1.1.0", packageDigest: "sha256:bb", size: 2, state: "RELEASE_STATE_YANKED", yankReason: "启动崩溃" }
        ]
      }
    });
    const info = await source.getExtension("film-set", new AbortController().signal);
    expect(info?.versions.map((entry) => [entry.version, entry.state, entry.yankReason])).toEqual([
      ["1.0.0", APPROVED, undefined],
      ["1.1.0", "RELEASE_STATE_YANKED", "启动崩溃"]
    ]);
  });

  it("下载：按会话地址解析签名 URL，并复用服务端声明的 size", async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      bodies.push(String(url));
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    const source = createServerMarketplaceSource({
      currentSession: async () => SESSION,
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
      call: async <T>(_session: RemoteSession, procedure: string) =>
        (procedure.endsWith("CreateDownloadUrl")
          ? { ok: true as const, value: { url: "/api/storage/x.wxt?sig=1", size: "3" } as T }
          : { ok: true as const, value: {} as T })
    });
    source.setSession(SESSION);

    const download = await source.download(
      { sourceId: "woohaa-server", extensionId: "film-set", version: "1.0.0", engines: { hostAbi: "^1", sdkAbi: "^1", protocolVersion: 1 }, packageDigest: "sha256:aa", size: 3 },
      new AbortController().signal
    );
    expect(bodies).toEqual(["https://server.example/api/storage/x.wxt?sig=1"]);
    expect(download.size).toBe(3);
    expect(download.stream).toBeInstanceOf(ReadableStream);
  });

  it("远端说「没有这个扩展」是业务结论：返回 null，而不是来源故障", async () => {
    const { source } = sourceWith({
      GetExtension: () => ({ ok: false, status: 404, code: "not_found", message: "远端服务暂不可用" })
    });
    await expect(source.getExtension("nope", new AbortController().signal)).resolves.toBeNull();
    await expect(source.resolve("nope", "^1.0.0", new AbortController().signal)).resolves.toBeNull();
  });

  it("注册失败不是激活失败：没有扩展点 / 宿主拒绝都只记日志", () => {
    const events: string[] = [];
    const log = (input: { event: string }) => { events.push(input.event); };
    const stub = (): MarketplaceSource => ({
      sourceId: "woohaa-server",
      label: "本部署市场",
      available: () => ({ ok: true }),
      search: async () => ({ items: [] }),
      resolve: async () => null,
      download: async () => ({ stream: new ReadableStream(), size: 0 })
    });

    // 1) 宿主没有扩展点：跳过，不算失败。
    expect(registerServerMarketplaceSource({}, stub(), log)).toBe(false);

    // 2) 宿主拒绝（非内置根）：记 warn，仍不算激活失败。
    const rejected = registerServerMarketplaceSource(
      {
        registerMarketplaceSource: () => {
          throw Object.assign(new Error("只有内置根扩展可以注册来源"), { code: "EXTENSION_MARKETPLACE_SOURCE_UNTRUSTED_ROOT" });
        }
      },
      stub(),
      log
    );
    expect(rejected).toBe(false);
    expect(events).toEqual(["remote-marketplace-unsupported", "remote-marketplace-register-failed"]);

    // 3) 正常注册。
    let registered: unknown = null;
    expect(
      registerServerMarketplaceSource({ registerMarketplaceSource: (source) => { registered = source; } }, stub(), log)
    ).toBe(true);
    expect(registered).not.toBeNull();
    expect(events.at(-1)).toBe("remote-marketplace-registered");
  });

  it("RPC 失败时抛出可读原因（宿主据此给出 MARKETPLACE_SOURCE_UNAVAILABLE）", async () => {
    const { source } = sourceWith({
      SearchExtensions: () => ({ ok: false, status: 503, code: "unavailable", message: "远端不可达" })
    });
    await expect(source.search({}, new AbortController().signal)).rejects.toThrow("远端不可达");
  });
});
