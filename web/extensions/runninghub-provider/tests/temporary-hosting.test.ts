import { describe, expect, it } from "vitest";
import type { HostStorageService } from "@woohaa3/contracts";
import successCode0 from "./fixtures/upload-success-code0.json";
import successCode200 from "./fixtures/upload-success-code200.json";
import error401 from "./fixtures/upload-error-401.json";
import missingUrl from "./fixtures/upload-missing-url.json";
import {
  createRunningHubTemporaryExposer,
  expiryOf,
  parseRunningHubUploadResponse,
  uploadRunningHubMedia,
  type RunningHubUploadInput,
  type RunningHubUploadResult
} from "../src/temporary-hosting.js";

const PUBLIC_URL = "https://rh-images.example.com/input/openapi/a.png?q-sign-algorithm=sha1&q-sign-time=1767852886%3B1767939286&q-signature=abc";

function storage(contentType = "image/png", bytes = Uint8Array.of(1, 2, 3)): HostStorageService {
  return {
    bucket: () => ({
      head: async () => ({ size: bytes.byteLength, contentType }),
      get: async () => ({ bytes, contentType })
    })
  } as unknown as HostStorageService;
}

function uploadResult(url = PUBLIC_URL, now = Date.now()): RunningHubUploadResult {
  return { ok: true, url, expiresAt: expiryOf(url, now) };
}

describe("RunningHub 新版上传响应", () => {
  it("接受 code 0 / 200 与真实 https download_url，fileName 只作内部引用", () => {
    expect(parseRunningHubUploadResponse(successCode200, { now: 1_767_900_000_000 })).toMatchObject({ ok: true, url: successCode200.data.download_url, filename: "openapi/a.png" });
    expect(parseRunningHubUploadResponse(successCode0, { now: 1_767_900_000_000 })).toMatchObject({ ok: true, url: successCode0.data.download_url, filename: "openapi/a.png" });
  });

  it("只有内部文件名、失败码、非 https 或私网地址一律判定失败", () => {
    expect(parseRunningHubUploadResponse(missingUrl)).toMatchObject({ ok: false, message: expect.stringContaining("download_url") });
    expect(parseRunningHubUploadResponse(error401)).toMatchObject({ ok: false, message: "ApiKey verification failed: API Key不存在" });
    expect(parseRunningHubUploadResponse({ code: 0, data: { type: "image", download_url: "http://rh.example.com/a.png" } })).toMatchObject({ ok: false });
    expect(parseRunningHubUploadResponse({ code: 0, data: { type: "image", download_url: "https://127.0.0.1/a.png" } })).toMatchObject({ ok: false });
    expect(parseRunningHubUploadResponse({ code: 0, data: { type: "image", download_url: "https://10.0.0.2/a.png" } })).toMatchObject({ ok: false });
  });

  it("有效期取签名到期与一天上限的较早值，并留安全余量", () => {
    const now = 1_767_900_000_000;
    expect(expiryOf(PUBLIC_URL, now)).toBe(1_767_939_286_000 - 5 * 60 * 1000);
    // 没有可确认的签名到期时按官方一天上限；不能承诺更久。
    const documented = expiryOf("https://rh-images.example.com/a.png", now);
    expect(documented).toBeGreaterThan(now + 20 * 60 * 60 * 1000);
    expect(documented).toBeLessThanOrEqual(now + 24 * 60 * 60 * 1000);
  });

  it("上传走 Bearer multipart，并只返回确认过的 download_url", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await uploadRunningHubMedia({
      bytes: Uint8Array.of(1, 2, 3), contentType: "image/png", filename: "a.png", apiKey: "k",
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ code: 0, data: { type: "image", download_url: PUBLIC_URL } }), { status: 200 });
      }) as unknown as typeof globalThis.fetch
    });
    expect(result).toMatchObject({ ok: true, url: PUBLIC_URL });
    expect(calls[0]!.url).toBe("https://www.runninghub.ai/openapi/v2/media/upload/binary");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(calls[0]!.init.body).toBeInstanceOf(FormData);
  });
});

describe("临时地址缓存与并发", () => {
  it("同一对象并发只上传一次，到期后重新上传", async () => {
    let now = 1_767_900_000_000;
    let uploads = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const exposer = createRunningHubTemporaryExposer({
      storage: storage(),
      getApiKey: () => "key",
      now: () => now,
      upload: async () => {
        uploads += 1;
        await gate;
        return uploadResult(PUBLIC_URL, now);
      }
    });
    const first = exposer.expose({ namespace: "media", key: "sha256-a.png" });
    const second = exposer.expose({ namespace: "media", key: "sha256-a.png" });
    release!();
    expect(await Promise.all([first, second])).toEqual([PUBLIC_URL, PUBLIC_URL]);
    expect(uploads).toBe(1);

    // 仍在安全窗口内：直接复用。
    expect(await exposer.expose({ namespace: "media", key: "sha256-a.png" })).toBe(PUBLIC_URL);
    expect(uploads).toBe(1);

    // 越过签名到期：重新上传。
    now = 1_767_940_000_000;
    expect(await exposer.expose({ namespace: "media", key: "sha256-a.png" })).toBe(PUBLIC_URL);
    expect(uploads).toBe(2);
  });

  it("失败清除进行中项，下一次独立请求可恢复；凭据 epoch 隔离缓存", async () => {
    let epoch = 1;
    let attempts = 0;
    const exposer = createRunningHubTemporaryExposer({
      storage: storage(),
      getApiKey: () => "key",
      getCredentialEpoch: () => epoch,
      upload: async (input: RunningHubUploadInput) => {
        attempts += 1;
        void input;
        if (attempts === 1) return { ok: false, message: "rate limited" };
        return uploadResult(PUBLIC_URL, Date.now());
      }
    });
    await expect(exposer.expose({ namespace: "media", key: "sha256-a.png" })).rejects.toThrow(/rate limited/);
    expect(await exposer.expose({ namespace: "media", key: "sha256-a.png" })).toBe(PUBLIC_URL);
    expect(attempts).toBe(2);

    // 新凭据 epoch 不能复用旧地址。
    epoch = 2;
    expect(await exposer.expose({ namespace: "media", key: "sha256-a.png" })).toBe(PUBLIC_URL);
    expect(attempts).toBe(3);
  });

  it("所需有效窗口超过一天时直接拒绝，不上传", async () => {
    let uploads = 0;
    const exposer = createRunningHubTemporaryExposer({
      storage: storage(),
      getApiKey: () => "key",
      upload: async () => { uploads += 1; return uploadResult(); }
    });
    await expect(exposer.expose({
      namespace: "media", key: "sha256-a.png", request: { requiredValiditySeconds: 2 * 24 * 60 * 60 }
    })).rejects.toThrow(/一天/);
    expect(uploads).toBe(0);
  });
});
