import { describe, expect, it, vi } from "vitest";
import { createGuardedFetch } from "../src/guarded-fetch.js";

const base = { baseUrl: "https://queue.fal.run", maxBytes: 1024, timeoutMs: 1000 };

describe("出网守卫", () => {
  it("可信 origin 原样放行；媒体下载只走受控路径", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("fal.media")) return new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } });
      return Response.json({ ok: true });
    });
    const guarded = createGuardedFetch({ ...base, fetchImpl: fetchImpl as typeof fetch });

    const api = await guarded("https://queue.fal.run/fal-ai/flux/schnell", { method: "POST" });
    expect(await api.json()).toEqual({ ok: true });

    const image = await guarded("https://v3.fal.media/files/x.png");
    expect(image.headers.get("content-type")).toBe("image/png");
    const mediaCall = fetchImpl.mock.calls[1] as unknown as [string, RequestInit | undefined];
    expect(new Headers(mediaCall[1]?.headers).get("authorization")).toBeNull();

    await expect(guarded("https://127.0.0.1/secret.png")).rejects.toThrow(/私网/);
    await expect(guarded("http://v3.fal.media/x.png")).rejects.toThrow(/https/);
  });

  it("拒绝未声明的内容类型与超过上限的响应", async () => {
    const html = createGuardedFetch({
      ...base,
      fetchImpl: (async () => new Response("<html>", { headers: { "content-type": "text/html" } })) as typeof fetch
    });
    await expect(html("https://v3.fal.media/x")).rejects.toThrow(/响应类型/);

    const large = createGuardedFetch({
      ...base,
      maxBytes: 4,
      fetchImpl: (async () => new Response(new Uint8Array(8), { headers: { "content-type": "image/png" } })) as typeof fetch
    });
    await expect(large("https://v3.fal.media/x")).rejects.toThrow(/上限/);
  });

  it("按声明放行音频；给 CDN 附加凭据由插件钩子决定", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push([String(input), init]);
      return new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } });
    }) as typeof fetch;
    const guarded = createGuardedFetch({
      ...base,
      allowedContentTypes: ["image/", "audio/"],
      prepareDownloadHeaders: (url, headers) => {
        if (url.hostname.endsWith("replicate.delivery")) headers.set("authorization", "Bearer test");
      },
      fetchImpl
    });
    const audio = await guarded("https://replicate.delivery/x.mp3");
    expect(audio.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Headers(calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer test");
  });

  it("重定向逐跳校验：跳到私网直接拒绝", async () => {
    const fetchImpl = (async (_input: string | URL | Request) =>
      new Response(null, { status: 302, headers: { location: "https://127.0.0.1/x.png" } })) as typeof fetch;
    const guarded = createGuardedFetch({ ...base, fetchImpl });
    await expect(guarded("https://v3.fal.media/x.png")).rejects.toThrow(/私网/);
  });

  it("拒绝非 http(s) URL", async () => {
    const guarded = createGuardedFetch({ ...base, fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(guarded("file:///etc/passwd")).rejects.toThrow(/URL 不合法/);
  });
});
