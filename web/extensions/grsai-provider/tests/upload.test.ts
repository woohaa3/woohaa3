import { describe, expect, it, vi } from "vitest";
import { uploadGrsaiReference } from "../src/upload.js";
import { createGrsaiRegistration } from "../src/backend.js";

const TOKEN_RESPONSE = {
  code: 0,
  msg: "success",
  data: {
    domain: "https://grsai-file.dakka.com.cn",
    key: "folder/a.png",
    token: "tk-1",
    url: "https://up-z2.qiniup.com"
  }
};

function tokenFetchMock(payload: unknown = TOKEN_RESPONSE, status = 200) {
  return vi.fn(async () => (status === 200 ? Response.json(payload) : new Response("nope", { status })));
}

describe("grsai 参考图上传", () => {
  it("注册的上传端口返回宿主契约要求的 URL 结果", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      String(input).includes("newUploadTokenZH")
        ? Response.json(TOKEN_RESPONSE)
        : Response.json({ hash: "h", key: "folder/a.png" }));
    const { registration } = createGrsaiRegistration({ apiKey: "test-key", fetchImpl: fetchImpl as typeof fetch });
    const input = { reference: { role: "reference", mediaType: "image/png" }, bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" };
    expect(await registration.uploadReference!(input)).toEqual({ url: "https://grsai-file.dakka.com.cn/folder/a.png" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const unavailable = createGrsaiRegistration({}).registration;
    expect(await unavailable.uploadReference!(input)).toBeUndefined();
  });

  it("先换令牌再传字节，返回域名 + key 的公网地址", async () => {
    const tokenFetch = tokenFetchMock();
    const uploadFetch = vi.fn(async () => Response.json({ hash: "h", key: "folder/a.png" }));
    const url = await uploadGrsaiReference({
      origin: "https://grsai.dakka.com.cn",
      apiKey: "test-key",
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
      tokenFetch: tokenFetch as unknown as typeof fetch,
      uploadFetch: uploadFetch as unknown as typeof fetch
    });

    expect(url).toBe("https://grsai-file.dakka.com.cn/folder/a.png");
    const tokenCall = tokenFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(tokenCall[0]).toBe("https://grsai.dakka.com.cn/client/resource/newUploadTokenZH");
    expect(new Headers(tokenCall[1].headers).get("authorization")).toBe("Bearer test-key");
    expect(JSON.parse(String(tokenCall[1].body))).toEqual({ sux: "png" });

    const uploadCall = uploadFetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(uploadCall[0])).toBe("https://up-z2.qiniup.com/");
    expect(uploadCall[1].method).toBe("POST");
    const form = uploadCall[1].body as FormData;
    expect(form.get("token")).toBe("tk-1");
    expect(form.get("key")).toBe("folder/a.png");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("令牌不完整、上传目标不合法或上传失败都报错", async () => {
    const base = { origin: "https://grsai.dakka.com.cn", apiKey: "k", bytes: new Uint8Array([1]), contentType: "image/jpeg" };
    await expect(uploadGrsaiReference({
      ...base,
      tokenFetch: tokenFetchMock({ code: 0, data: { domain: "https://d.test", key: "a.jpg", url: "https://up.test" } }) as unknown as typeof fetch,
      uploadFetch: vi.fn() as unknown as typeof fetch
    })).rejects.toThrow(/响应不完整/);

    const privateTarget = tokenFetchMock({ code: 0, data: { domain: "https://d.test", key: "a.jpg", token: "t", url: "https://127.0.0.1/up" } });
    await expect(uploadGrsaiReference({
      ...base,
      tokenFetch: privateTarget as unknown as typeof fetch,
      uploadFetch: vi.fn() as unknown as typeof fetch
    })).rejects.toThrow(/私网/);

    await expect(uploadGrsaiReference({
      ...base,
      tokenFetch: tokenFetchMock(TOKEN_RESPONSE, 500) as unknown as typeof fetch,
      uploadFetch: vi.fn() as unknown as typeof fetch
    })).rejects.toThrow(/上传令牌请求失败/);

    await expect(uploadGrsaiReference({
      ...base,
      tokenFetch: tokenFetchMock() as unknown as typeof fetch,
      uploadFetch: vi.fn(async () => new Response("no", { status: 403 })) as unknown as typeof fetch
    })).rejects.toThrow(/上传失败/);
  });
});
