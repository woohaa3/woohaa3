import { describe, expect, it, vi } from "vitest";
import {
  createSdpppxReferenceUploader,
  SDPPPX_UPLOAD_MAX_BYTES
} from "../src/backend/reference.js";
import type { SessionManager } from "../src/backend/session.js";
import { SDPPPX_ERROR_CODES } from "../src/shared.js";
import { readTestConfig, FULL_ENV, PNG_BYTES, createFetch, headersOf, jsonResponse, textResponse } from "./helpers.js";

function setup(handler: Parameters<typeof createFetch>[0], recommend?: () => string | null) {
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
    now: () => 1_000_000,
    ...(recommend ? { recommendUploadProvider: recommend } : {}),
    log: () => undefined
  });
  return { uploader, session, calls };
}

describe("参考素材上传", () => {
  it("使用默认上传通道与 X-Tenant-ID、Content-Type、Bearer token", async () => {
    const { uploader, calls } = setup(() => jsonResponse({ url: "https://files.example/a.png" }));
    const result = await uploader.upload({
      bytes: PNG_BYTES,
      contentType: "image/png",
      role: "reference_image",
      storageKey: "media/cat.png"
    });
    expect(result).toEqual({ url: "https://files.example/a.png" });
    expect(uploader.isUploaded("https://files.example/a.png")).toBe(true);

    const call = calls[0]!;
    expect(call.url).toContain("https://sdpppx.zombee.tech/ppserver/tasks/upload?provider=grsai");
    expect(call.url).toContain("filename=cat.png");
    expect(call.init.method).toBe("POST");
    expect(call.init.body).toBe(PNG_BYTES);
    const headers = headersOf(call);
    expect(headers["X-Tenant-ID"]).toBe("tenant-1");
    expect(headers["Content-Type"]).toBe("image/png");
    expect(headers.Authorization).toBe("Bearer jwt-1");
  });

  it("describe 的推荐通道可用时优先；不支持的推荐值回落到配置默认值", async () => {
    const supported = setup(() => jsonResponse({ url: "https://files.example/a.png" }), () => "grsai");
    await supported.uploader.upload({ bytes: PNG_BYTES, contentType: "image/png" });
    expect(supported.calls[0]!.url).toContain("provider=grsai");

    const unsupported = setup(() => jsonResponse({ url: "https://files.example/a.png" }), () => "runninghub");
    await unsupported.uploader.upload({ bytes: PNG_BYTES, contentType: "image/png" });
    expect(unsupported.calls[0]!.url).toContain("provider=grsai");
  });

  it("401 清会话并返回 session-expired；其它失败返回 upload-failed", async () => {
    const unauthorized = setup(() => textResponse("no", { status: 401 }));
    await expect(
      unauthorized.uploader.upload({ bytes: PNG_BYTES, contentType: "image/png" })
    ).rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.sessionExpired });
    expect(unauthorized.session.clear).toHaveBeenCalledWith(SDPPPX_ERROR_CODES.sessionExpired);

    const failing = setup(() => textResponse("down", { status: 503 }));
    await expect(
      failing.uploader.upload({ bytes: PNG_BYTES, contentType: "image/png" })
    ).rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.uploadFailed });
    expect(failing.uploader.isUploaded("https://files.example/a.png")).toBe(false);
  });

  it("空素材、超大素材、响应缺地址都拒绝，且不发无意义请求", async () => {
    const { uploader, calls } = setup(() => jsonResponse({}));
    await expect(uploader.upload({ bytes: new Uint8Array(), contentType: "image/png" })).rejects.toMatchObject({
      code: SDPPPX_ERROR_CODES.uploadFailed
    });
    expect(calls).toHaveLength(0);

    const huge = new Uint8Array(SDPPPX_UPLOAD_MAX_BYTES + 1);
    await expect(uploader.upload({ bytes: huge, contentType: "image/png" })).rejects.toMatchObject({
      code: SDPPPX_ERROR_CODES.uploadFailed
    });
    expect(calls).toHaveLength(0);

    await expect(uploader.upload({ bytes: PNG_BYTES, contentType: "image/png" })).rejects.toMatchObject({
      code: SDPPPX_ERROR_CODES.uploadFailed
    });
  });

  it("失败后允许名单保持为空，避免提交本机签名地址", async () => {
    const { uploader } = setup(() => textResponse("down", { status: 500 }));
    await expect(uploader.upload({ bytes: PNG_BYTES, contentType: "image/png" })).rejects.toBeDefined();
    expect(uploader.size()).toBe(0);
    expect(uploader.isUploaded("http://127.0.0.1:1234/signed.png")).toBe(false);
  });
});
