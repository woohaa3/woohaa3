import { describe, expect, it, vi } from "vitest";
import { createSdpppxReferenceUploader } from "../src/backend/reference.js";
import { SDPPPX_MEDIA_MAX_BYTES } from "../src/backend/media-upload.js";
import type { SessionManager } from "../src/backend/session.js";
import { SDPPPX_ERROR_CODES } from "../src/shared.js";
import { readTestConfig, FULL_ENV, PNG_BYTES, createFetch, headersOf, jsonResponse, textResponse } from "./helpers.js";

function uploadedResponse(url = "https://files.example/a.png", bytes = PNG_BYTES) {
  return jsonResponse({
    code: 0,
    data: { url, media_type: "image/png", size: bytes.byteLength }
  });
}

function setup(handler: Parameters<typeof createFetch>[0]) {
  const { fetchImpl, calls } = createFetch(handler);
  const config = readTestConfig(FULL_ENV);
  const session = {
    accessToken: vi.fn(async () => "jwt-1"),
    clear: vi.fn(async () => undefined)
  } as unknown as SessionManager;
  const uploader = createSdpppxReferenceUploader({
    config: () => config,
    session,
    fetchImpl,
    log: () => undefined
  });
  return { uploader, session, calls };
}

describe("参考素材上传", () => {
  it("只走 /media/upload：Bearer 与真实 Content-Type，不带旧通道参数", async () => {
    const { uploader, calls } = setup(() => uploadedResponse());
    const result = await uploader.upload({
      bytes: PNG_BYTES,
      contentType: "image/png",
      role: "reference_image",
      storageKey: "media/cat.png"
    });
    expect(result).toEqual({ url: "https://files.example/a.png" });
    expect(uploader.isUploaded("https://files.example/a.png")).toBe(true);

    // 临时图床的成功地址与模板参考上传共享同一允许名单。
    uploader.rememberUrl("https://files.example/from-temporary.png");
    expect(uploader.isUploaded("https://files.example/from-temporary.png")).toBe(true);

    const call = calls[0]!;
    expect(call.url).toBe("https://sdpppx.zombee.tech/ppserver/media/upload");
    expect(call.url).not.toContain("/tasks/upload");
    expect(call.url).not.toContain("provider=");
    expect(call.url).not.toContain("filename=");
    expect(call.init.method).toBe("POST");
    expect(call.init.body).toBe(PNG_BYTES);
    const headers = headersOf(call);
    expect(headers["X-Tenant-ID"]).toBeUndefined();
    expect(headers["content-type"]).toBe("image/png");
    expect(headers.authorization).toBe("Bearer jwt-1");
  });

  it("401 清会话并返回 session-expired；其它失败返回 media 稳定码", async () => {
    const unauthorized = setup(() => textResponse("no", { status: 401 }));
    await expect(
      unauthorized.uploader.upload({ bytes: PNG_BYTES, contentType: "image/png" })
    ).rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.sessionExpired });
    expect(unauthorized.session.clear).toHaveBeenCalledWith(SDPPPX_ERROR_CODES.sessionExpired);

    const failing = setup(() => textResponse("down", { status: 503 }));
    await expect(
      failing.uploader.upload({ bytes: PNG_BYTES, contentType: "image/png" })
    ).rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.mediaUploadUnavailable });
    expect(failing.uploader.isUploaded("https://files.example/a.png")).toBe(false);
  });

  it("空素材、超大素材、响应不完整都拒绝，且不发无意义请求", async () => {
    const { uploader, calls } = setup(() => uploadedResponse());
    await expect(uploader.upload({ bytes: new Uint8Array(), contentType: "image/png" })).rejects.toMatchObject({
      code: SDPPPX_ERROR_CODES.mediaUnsupported
    });
    expect(calls).toHaveLength(0);

    const huge = new Uint8Array(SDPPPX_MEDIA_MAX_BYTES + 1);
    await expect(uploader.upload({ bytes: huge, contentType: "image/png" })).rejects.toMatchObject({
      code: SDPPPX_ERROR_CODES.mediaUnsupported
    });
    expect(calls).toHaveLength(0);

    const incomplete = setup(() => jsonResponse({ code: 0, data: {} }));
    await expect(
      incomplete.uploader.upload({ bytes: PNG_BYTES, contentType: "image/png" })
    ).rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.mediaInvalidResponse });
  });

  it("失败后允许名单保持为空，避免提交本机签名地址", async () => {
    const { uploader } = setup(() => textResponse("down", { status: 500 }));
    await expect(uploader.upload({ bytes: PNG_BYTES, contentType: "image/png" })).rejects.toBeDefined();
    expect(uploader.size()).toBe(0);
    expect(uploader.isUploaded("http://127.0.0.1:1234/signed.png")).toBe(false);
  });
});
