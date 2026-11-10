import { describe, expect, it } from "vitest";
import {
  parseSdpppxMediaUploadResponse,
  probeSdpppxMediaReadable,
  uploadSdpppxMedia,
  validateSdpppxMedia,
  SDPPPX_MEDIA_MAX_BYTES,
  mediaKindOf
} from "../src/backend/media-upload.js";
import { SDPPPX_ERROR_CODES } from "../src/shared.js";
import { createFetch, jsonResponse, textResponse } from "./helpers.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const PUBLIC_URL = "https://cos.example.com/media/a.png";

/** 恰好 20 MiB / 超一字节；不实际分配两次大数组，按需生成。 */
function bytesOf(size: number): Uint8Array {
  return new Uint8Array(size);
}

describe("SDPPPX 媒体上传的本地限制", () => {
  it("恰好 20 MiB 不被误拒，超过 1 字节即拒绝，且都不发请求", async () => {
    expect(validateSdpppxMedia(bytesOf(SDPPPX_MEDIA_MAX_BYTES), "video/mp4")).toBeNull();
    expect(validateSdpppxMedia(bytesOf(SDPPPX_MEDIA_MAX_BYTES + 1), "video/mp4")).toMatchObject({
      ok: false,
      code: SDPPPX_ERROR_CODES.mediaUnsupported
    });

    const { fetchImpl, calls } = createFetch(() => jsonResponse({}));
    const tooBig = await uploadSdpppxMedia({
      baseUrl: "https://sdpppx.example.com/ppserver",
      accessToken: "t",
      bytes: bytesOf(2),
      contentType: "audio/mpeg",
      fetchImpl
    });
    expect(tooBig).toMatchObject({ ok: false, code: SDPPPX_ERROR_CODES.mediaUnsupported });
    const empty = await uploadSdpppxMedia({
      baseUrl: "https://sdpppx.example.com/ppserver",
      accessToken: "t",
      bytes: new Uint8Array(),
      contentType: "image/png",
      fetchImpl
    });
    expect(empty).toMatchObject({ ok: false, code: SDPPPX_ERROR_CODES.mediaUnsupported });
    expect(calls).toHaveLength(0);
  });

  it("只把 image/video 视为可上传类型", () => {
    expect(mediaKindOf("image/png")).toBe("image");
    expect(mediaKindOf("video/mp4; codecs=avc1")).toBe("video");
    expect(mediaKindOf("audio/mpeg")).toBeUndefined();
    expect(mediaKindOf("application/octet-stream")).toBeUndefined();
  });
});

describe("SDPPPX /media/upload 请求", () => {
  it("发往 baseUrl 下 /media/upload，Bearer + 原始字节 + 真实 MIME，不带旧接口头与参数", async () => {
    const { fetchImpl, calls } = createFetch(() =>
      jsonResponse({ code: 0, data: { url: PUBLIC_URL, media_type: "image/png", size: PNG.byteLength } })
    );
    const result = await uploadSdpppxMedia({
      baseUrl: "https://sdpppx.example.com/ppserver/",
      accessToken: "access-1",
      bytes: PNG,
      contentType: "image/png",
      fetchImpl
    });
    expect(result).toMatchObject({ ok: true, url: PUBLIC_URL, mediaType: "image/png", size: PNG.byteLength });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://sdpppx.example.com/ppserver/media/upload");
    expect(call.url).not.toContain("/tasks/upload");
    expect(call.url).not.toContain("provider=");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer access-1");
    expect(headers["content-type"]).toBe("image/png");
    expect(Object.keys(headers).map(key => key.toLowerCase())).not.toContain("x-tenant-id");
    expect(call.init.body).toBe(PNG);
  });

  it("未登录时直接拒绝，不发上传请求", async () => {
    const { fetchImpl, calls } = createFetch(() => jsonResponse({}));
    const result = await uploadSdpppxMedia({
      baseUrl: "https://sdpppx.example.com/ppserver",
      accessToken: "   ",
      bytes: PNG,
      contentType: "image/png",
      fetchImpl
    });
    expect(result).toMatchObject({ ok: false, code: SDPPPX_ERROR_CODES.sessionExpired });
    expect(calls).toHaveLength(0);
  });

  it("401 归会话失效，403 归权限拒绝，413/415 归不支持，429/5xx 可定位", async () => {
    const statuses: Array<[number, string]> = [
      [401, SDPPPX_ERROR_CODES.sessionExpired],
      [403, SDPPPX_ERROR_CODES.mediaForbidden],
      [413, SDPPPX_ERROR_CODES.mediaUnsupported],
      [415, SDPPPX_ERROR_CODES.mediaUnsupported],
      [429, SDPPPX_ERROR_CODES.mediaRateLimited],
      [500, SDPPPX_ERROR_CODES.mediaUploadUnavailable],
      [503, SDPPPX_ERROR_CODES.mediaUploadUnavailable],
      [400, SDPPPX_ERROR_CODES.mediaUploadFailed]
    ];
    for (const [status, code] of statuses) {
      const { fetchImpl } = createFetch(() => textResponse("upstream body", { status }));
      const result = await uploadSdpppxMedia({
        baseUrl: "https://sdpppx.example.com/ppserver",
        accessToken: "t",
        bytes: PNG,
        contentType: "image/png",
        fetchImpl
      });
      expect(result).toMatchObject({ ok: false, status, code });
      // 不泄露上游正文。
      expect(JSON.stringify(result)).not.toContain("upstream body");
    }
  });

  it("超时与网络失败不抛异常，返回可定位失败", async () => {
    const hanging = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as unknown as typeof globalThis.fetch;
    const timedOut = await uploadSdpppxMedia({
      baseUrl: "https://sdpppx.example.com/ppserver",
      accessToken: "t",
      bytes: PNG,
      contentType: "image/png",
      fetchImpl: hanging,
      timeoutMs: 5
    });
    expect(timedOut).toMatchObject({ ok: false, code: SDPPPX_ERROR_CODES.mediaUploadUnavailable });
    expect((timedOut as { message: string }).message).toContain("超时");

    const failing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    const failed = await uploadSdpppxMedia({
      baseUrl: "https://sdpppx.example.com/ppserver",
      accessToken: "t",
      bytes: PNG,
      contentType: "image/png",
      fetchImpl: failing
    });
    expect(failed).toMatchObject({ ok: false, code: SDPPPX_ERROR_CODES.mediaUploadUnavailable });
  });

  it("调用者取消映射为取消语义", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchImpl, calls } = createFetch(() => jsonResponse({}));
    const result = await uploadSdpppxMedia({
      baseUrl: "https://sdpppx.example.com/ppserver",
      accessToken: "t",
      bytes: PNG,
      contentType: "image/png",
      fetchImpl,
      signal: controller.signal
    });
    expect(result).toMatchObject({ ok: false, code: SDPPPX_ERROR_CODES.mediaCancelled });
    expect(calls).toHaveLength(0);
  });
});

describe("SDPPPX /media/upload 响应结构", () => {
  const expected = { contentType: "image/png", size: PNG.byteLength };

  it("只接受数值 code 0 与完整一致的 data", () => {
    expect(parseSdpppxMediaUploadResponse(
      { code: 0, data: { url: PUBLIC_URL, media_type: "image/png", size: PNG.byteLength } },
      expected
    )).toMatchObject({ ok: true, url: PUBLIC_URL });
  });

  it("顶层 url、字符串 code、丢字段、类型/大小不符都失败", () => {
    const cases: unknown[] = [
      { url: PUBLIC_URL, media_type: "image/png", size: PNG.byteLength },
      { code: "0", data: { url: PUBLIC_URL, media_type: "image/png", size: PNG.byteLength } },
      { code: 0, data: { url: PUBLIC_URL, size: PNG.byteLength } },
      { code: 0, data: { media_type: "image/png", size: PNG.byteLength } },
      { code: 0, data: { url: PUBLIC_URL, media_type: "image/png" } },
      { code: 0, data: { url: PUBLIC_URL, media_type: "video/mp4", size: PNG.byteLength } },
      { code: 0, data: { url: PUBLIC_URL, media_type: "image/png", size: PNG.byteLength + 1 } },
      { code: 0, data: { url: "http://cos.example.com/a.png", media_type: "image/png", size: PNG.byteLength } },
      { code: 0, data: { url: "https://127.0.0.1/a.png", media_type: "image/png", size: PNG.byteLength } },
      { code: 0, data: { url: "https://10.0.0.2/a.png", media_type: "image/png", size: PNG.byteLength } },
      { code: 1, message: "denied" }
    ];
    for (const payload of cases) {
      expect(parseSdpppxMediaUploadResponse(payload, expected)).toMatchObject({
        ok: false,
        code: SDPPPX_ERROR_CODES.mediaInvalidResponse
      });
    }
  });

  it("非 JSON 响应不当作成功", async () => {
    const { fetchImpl } = createFetch(() => textResponse("<html>ok</html>"));
    const result = await uploadSdpppxMedia({
      baseUrl: "https://sdpppx.example.com/ppserver",
      accessToken: "t",
      bytes: PNG,
      contentType: "image/png",
      fetchImpl
    });
    expect(result).toMatchObject({ ok: false, code: SDPPPX_ERROR_CODES.mediaInvalidResponse });
  });
});

describe("SDPPPX 匿名读取核验", () => {
  it("不带任何凭据，只取有界前缀并通过类型核对", async () => {
    const { fetchImpl, calls } = createFetch(() =>
      new Response(PNG, { status: 206, headers: { "content-type": "image/png" } })
    );
    const result = await probeSdpppxMediaReadable({
      url: PUBLIC_URL,
      mediaType: "image/png",
      fetchImpl
    });
    expect(result).toEqual({ ok: true });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(Object.keys(headers).map(key => key.toLowerCase()).sort()).toEqual(["accept", "range"]);
    expect(calls[0]!.init.redirect).toBe("manual");
  });

  it("403/404、HTML 错误、空内容、类型不符都视为不可读", async () => {
    const cases: Array<() => Response> = [
      () => textResponse("forbidden", { status: 403 }),
      () => textResponse("missing", { status: 404 }),
      () => new Response("<html>error</html>", { status: 200, headers: { "content-type": "text/html" } }),
      () => new Response(new Uint8Array(), { status: 200, headers: { "content-type": "image/png" } }),
      () => new Response(PNG, { status: 200, headers: { "content-type": "video/mp4" } })
    ];
    for (const handler of cases) {
      const { fetchImpl } = createFetch(handler);
      const result = await probeSdpppxMediaReadable({ url: PUBLIC_URL, mediaType: "image/png", fetchImpl });
      expect(result.ok).toBe(false);
    }
  });

  it("重定向逐跳校验，私网或非 https 目标直接拒绝", async () => {
    const { fetchImpl, calls } = createFetch(({ url }) =>
      url === PUBLIC_URL
        ? new Response(null, { status: 302, headers: { location: "https://127.0.0.1/private.png" } })
        : new Response(PNG, { status: 200, headers: { "content-type": "image/png" } })
    );
    const result = await probeSdpppxMediaReadable({ url: PUBLIC_URL, mediaType: "image/png", fetchImpl });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("私网") });
    expect(calls).toHaveLength(1);

    const { fetchImpl: httpFetch } = createFetch(() =>
      new Response(null, { status: 302, headers: { location: "http://cos.example.com/a.png" } })
    );
    await expect(probeSdpppxMediaReadable({ url: PUBLIC_URL, mediaType: "image/png", fetchImpl: httpFetch }))
      .resolves.toMatchObject({ ok: false });
  });

  it("允许一次公开 https 跳转", async () => {
    const { fetchImpl } = createFetch(({ url }) =>
      url === PUBLIC_URL
        ? new Response(null, { status: 302, headers: { location: "https://cdn.example.com/a.png" } })
        : new Response(PNG, { status: 200, headers: { "content-type": "image/png" } })
    );
    await expect(probeSdpppxMediaReadable({ url: PUBLIC_URL, mediaType: "image/png", fetchImpl }))
      .resolves.toEqual({ ok: true });
  });
});
