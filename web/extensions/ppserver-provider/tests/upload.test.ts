import { describe, expect, it, vi } from "vitest";
import { uploadPpserverReference } from "../src/upload.js";
import { createPpserverRegistration } from "../src/backend.js";

const bytes = new Uint8Array([1, 2, 3]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("uploadPpserverReference", () => {
  it("把原始字节 POST 到 /media/upload，带 Bearer，取 data.fileUrl", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { fileUrl: "https://cdn.example/a.png" } }));
    const url = await uploadPpserverReference({
      baseUrl: "https://api.example/ppserver/",
      accessToken: "tok",
      bytes,
      contentType: "image/png",
      fetchImpl
    });
    expect(url).toBe("https://cdn.example/a.png");
    const [endpoint, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe("https://api.example/ppserver/media/upload");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer tok");
    expect(headers.get("content-type")).toBe("image/png");
    expect(init.body).toBe(bytes);
  });

  it("令牌函数每次现取；纯文本 URL 也认", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("https://cdn.example/b.png"));
    const getToken = vi.fn().mockResolvedValue("fresh");
    const url = await uploadPpserverReference({
      baseUrl: "https://api.example/ppserver",
      accessToken: getToken,
      bytes,
      contentType: "image/jpeg",
      fetchImpl
    });
    expect(url).toBe("https://cdn.example/b.png");
    expect(new Headers((fetchImpl.mock.calls[0] as [string, RequestInit])[1].headers).get("authorization")).toBe("Bearer fresh");
  });

  it("HTTP 失败抛错且不带令牌；空字节或无令牌不发请求", async () => {
    const failing = vi.fn().mockResolvedValue(new Response("secret-tok echoed", { status: 500 }));
    await expect(
      uploadPpserverReference({ baseUrl: "https://a.example", accessToken: "secret-tok", bytes, contentType: "image/png", fetchImpl: failing })
    ).rejects.toThrow(/HTTP 500$/);

    const never = vi.fn();
    expect(await uploadPpserverReference({ baseUrl: "https://a.example", accessToken: "t", bytes: new Uint8Array(), contentType: "image/png", fetchImpl: never })).toBeUndefined();
    expect(await uploadPpserverReference({ baseUrl: "https://a.example", accessToken: " ", bytes, contentType: "image/png", fetchImpl: never })).toBeUndefined();
    expect(never).not.toHaveBeenCalled();
  });

  it("响应里没有地址时返回 undefined", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    expect(await uploadPpserverReference({ baseUrl: "https://a.example", accessToken: "t", bytes, contentType: "image/png", fetchImpl })).toBeUndefined();
  });
});

describe("registration.uploadReference", () => {
  it("可用时挂上钩子并返回 { url }；不可用时返回 undefined", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ url: "https://cdn.example/c.png" }));
    const ready = createPpserverRegistration({
      accessToken: "tok",
      baseUrl: "https://api.example/ppserver",
      supabaseUrl: "https://sb.example",
      fetchImpl
    }).registration;
    const input = { reference: { role: "reference", mediaType: "image/png" }, bytes, contentType: "image/png" } as never;
    expect(await ready.uploadReference!(input)).toEqual({ url: "https://cdn.example/c.png" });

    const idle = createPpserverRegistration({ baseUrl: "https://api.example/ppserver", fetchImpl }).registration;
    expect(await idle.uploadReference!(input)).toBeUndefined();
  });
});
