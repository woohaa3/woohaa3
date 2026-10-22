import { describe, expect, it, vi } from "vitest";
import { createGuardedFetch } from "@woohaa3/provider-sdk";

describe("Replicate 出网守卫", () => {
  it("给 replicate.delivery 带上 Token，并拒绝私网地址", async () => {
    const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) =>
      new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } })
    );
    const guarded = createGuardedFetch({
      baseUrl: "https://api.replicate.com/v1",
      maxBytes: 1024,
      timeoutMs: 1000,
      prepareDownloadHeaders: (url, headers) => {
        const host = url.hostname.toLowerCase();
        if (host === "replicate.delivery" || host.endsWith(".replicate.delivery")) headers.set("authorization", "Bearer r8_test");
      },
      fetchImpl: fetchImpl as typeof fetch
    });
    const response = await guarded("https://replicate.delivery/out.png");
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Headers((fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.headers).get("authorization")).toBe("Bearer r8_test");
    await expect(guarded("https://127.0.0.1/secret.png")).rejects.toThrow(/私网/);
    await expect(guarded("http://cdn.example/out.png")).rejects.toThrow(/https/);
  });
});
