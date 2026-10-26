import { describe, expect, it, vi } from "vitest";
import { createMarketplaceRemote } from "./marketplace-remote.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("marketplace remote", () => {
  it("search / extension / install 的路径与形态", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.startsWith("/api/extensions/marketplace/search")) return json(200, { items: [], sources: [{ sourceId: "woohaa-server", label: "x", ok: true }], unavailable: [] });
      if (url.startsWith("/api/extensions/marketplace/extension")) return json(200, { sourceId: "woohaa-server", extension: { extensionId: "demo", label: "Demo", versions: [] }, trustedKeyIds: [], signingKeys: [] });
      return json(202, { jobId: "j1" });
    }) as unknown as typeof fetch;
    const remote = createMarketplaceRemote({ fetchImpl });
    expect((await remote.search({ text: "a b", sourceId: "woohaa-server" })).ok).toBe(true);
    expect(calls[0]!.url).toBe("/api/extensions/marketplace/search?q=a+b&sourceId=woohaa-server");
    expect((await remote.extension({ sourceId: "woohaa-server", extensionId: "demo" })).ok).toBe(true);
    expect(calls[1]!.url).toBe("/api/extensions/marketplace/extension?sourceId=woohaa-server&extensionId=demo");
    expect(await remote.install({ sourceId: "woohaa-server", extensionId: "demo", range: "1.0.0" })).toEqual({ ok: true, jobId: "j1" });
    expect(calls[2]!.init).toMatchObject({ method: "POST", body: JSON.stringify({ sourceId: "woohaa-server", extensionId: "demo", range: "1.0.0" }) });
  });

  it("错误映射：宿主 code/message 透传；网络失败为 unavailable", async () => {
    const remote = createMarketplaceRemote({ fetchImpl: (async () => json(404, { code: "MARKETPLACE_SOURCE_NOT_FOUND", message: "没有" })) as unknown as typeof fetch });
    expect(await remote.extension({ sourceId: "s", extensionId: "x" })).toEqual({ ok: false, code: "MARKETPLACE_SOURCE_NOT_FOUND", error: "没有" });
    const offline = createMarketplaceRemote({ fetchImpl: (async () => { throw new Error("net"); }) as unknown as typeof fetch });
    expect(await offline.search({})).toMatchObject({ ok: false, code: "unavailable" });
  });
});
