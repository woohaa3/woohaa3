import { describe, expect, it, vi } from "vitest";
import { createGuardedFetch } from "@woohaa3/provider-sdk";

describe("fal 出网守卫", () => {
  it("放行队列 origin，下载只允许 https 图片/音频，不给 CDN 追加凭据", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("fal.media")) return new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } });
      return Response.json({ ok: true });
    });
    const guarded = createGuardedFetch({
      baseUrl: "https://queue.fal.run",
      maxBytes: 1024,
      timeoutMs: 1000,
      allowedContentTypes: ["image/", "audio/"],
      fetchImpl: fetchImpl as typeof fetch
    });
    const api = await guarded("https://queue.fal.run/fal-ai/flux/schnell", { method: "POST" });
    expect(await api.json()).toEqual({ ok: true });

    const image = await guarded("https://v3.fal.media/files/x.png");
    expect(image.headers.get("content-type")).toBe("image/png");
    const mediaCall = fetchImpl.mock.calls[1] as unknown as [string, RequestInit | undefined];
    expect(new Headers(mediaCall[1]?.headers).get("authorization")).toBeNull();

    await expect(guarded("https://127.0.0.1/secret.png")).rejects.toThrow(/私网/);
    await expect(guarded("http://v3.fal.media/x.png")).rejects.toThrow(/https/);
  });

  it("拒绝非图片/音频响应与超过上限的响应", async () => {
    const html = createGuardedFetch({
      baseUrl: "https://queue.fal.run",
      maxBytes: 1024,
      timeoutMs: 1000,
      fetchImpl: (async () => new Response("<html>", { headers: { "content-type": "text/html" } })) as typeof fetch
    });
    await expect(html("https://v3.fal.media/x")).rejects.toThrow(/响应类型/);

    const large = createGuardedFetch({
      baseUrl: "https://queue.fal.run",
      maxBytes: 4,
      timeoutMs: 1000,
      fetchImpl: (async () => new Response(new Uint8Array([1, 2, 3, 4, 5]), { headers: { "content-type": "image/png" } })) as typeof fetch
    });
    await expect(large("https://v3.fal.media/x.png")).rejects.toThrow(/上限/);
  });
});
