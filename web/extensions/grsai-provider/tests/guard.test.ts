import { describe, expect, it, vi } from "vitest";
import { assertPublicHttpsUrl, createGuardedFetch } from "@woohaa3/provider-sdk";

describe("grsai 出网守卫", () => {
  it("放行自己的 origin，下载只允许 https 图片", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("grsai-file")) return new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } });
      return Response.json({ ok: true });
    });
    const guarded = createGuardedFetch({
      baseUrl: "https://grsai.dakka.com.cn",
      maxBytes: 1024,
      timeoutMs: 1000,
      fetchImpl: fetchImpl as typeof fetch
    });
    expect(await (await guarded("https://grsai.dakka.com.cn/v1/api/generate", { method: "POST" })).json()).toEqual({ ok: true });
    const image = await guarded("https://grsai-file.dakka.com.cn/a.png");
    expect(image.headers.get("content-type")).toBe("image/png");

    await expect(guarded("https://10.0.0.7/secret.png")).rejects.toThrow(/私网/);
    await expect(guarded("http://grsai-file.dakka.com.cn/a.png")).rejects.toThrow(/https/);
  });

  it("上传目标必须是公网 https", () => {
    expect(assertPublicHttpsUrl("https://up-z2.qiniup.com").hostname).toBe("up-z2.qiniup.com");
    expect(() => assertPublicHttpsUrl("http://up-z2.qiniup.com")).toThrow(/https/);
    expect(() => assertPublicHttpsUrl("https://localhost/upload")).toThrow(/本机/);
    expect(() => assertPublicHttpsUrl("https://192.168.1.10/upload")).toThrow(/私网/);
    expect(() => assertPublicHttpsUrl("not a url")).toThrow(/不合法/);
  });
});
