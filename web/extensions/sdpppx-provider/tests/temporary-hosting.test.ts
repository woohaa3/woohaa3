import { describe, expect, it, vi } from "vitest";
import type { HostStorageService } from "@woohaa3/contracts";
import { createSdpppxTemporaryExposer, SDPPPX_TEMPORARY_EXPOSER_ID } from "../src/backend/temporary-hosting.js";
import { createMemorySessionStore, createSessionManager, type SdpppxSession, type SessionManager, type SessionStore } from "../src/backend/session.js";
import { SDPPPX_ERROR_CODES } from "../src/shared.js";
import { createFetch, jsonResponse, PNG_BYTES, readTestConfig } from "./helpers.js";

const NOW = 1_800_000_000_000;
const PUBLIC_URL = "https://cos.example.com/media/a.png";

const SESSION: SdpppxSession = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: NOW + 3_600_000,
  userId: "user-1",
  displayName: "小伍",
  avatarUrl: null
};

function storageOf(objects: Record<string, { bytes: Uint8Array; contentType?: string }> = {}) {
  const writes: string[] = [];
  const storage = {
    bucket: () => ({
      head: async (key: string) => {
        const object = objects[key];
        return object ? { size: object.bytes.byteLength, contentType: object.contentType } : null;
      },
      get: async (key: string) => {
        const object = objects[key];
        if (!object) throw Object.assign(new Error("missing"), { code: "STORAGE_OBJECT_NOT_FOUND" });
        return object;
      },
      put: async (key: string) => {
        writes.push(key);
      }
    })
  } as unknown as HostStorageService;
  return { storage, writes };
}

function managerOf(store: SessionStore = createMemorySessionStore(SESSION), fetchImpl?: typeof globalThis.fetch): SessionManager {
  return createSessionManager({
    config: () => readTestConfig(),
    store,
    now: () => NOW,
    ...(fetchImpl ? { fetchImpl } : {})
  });
}

function uploadOk(url = PUBLIC_URL, bytes = PNG_BYTES) {
  return { ok: true as const, url, mediaType: "image/png", size: bytes.byteLength };
}

const probeOk = async () => ({ ok: true as const });

function exposerOf(options: {
  objects?: Record<string, { bytes: Uint8Array; contentType?: string }>;
  session?: SessionManager;
  credentialEpoch?: () => number;
  upload?: Parameters<typeof createSdpppxTemporaryExposer>[0]["upload"];
  probe?: Parameters<typeof createSdpppxTemporaryExposer>[0]["probe"];
} = {}) {
  const { storage } = storageOf(options.objects ?? { "sha256-a.png": { bytes: PNG_BYTES, contentType: "image/png" } });
  const session = options.session ?? managerOf();
  return createSdpppxTemporaryExposer({
    storage,
    config: () => readTestConfig(),
    session,
    ...(options.credentialEpoch ? { getCredentialEpoch: options.credentialEpoch } : {}),
    ...(options.upload ? { upload: options.upload } : {}),
    probe: options.probe ?? probeOk
  });
}

/** 等共享上传真正开始（测试里用来制造「上传期间发生登出/换号」）。 */
function started(): { wait: Promise<void>; mark: () => void } {
  let mark: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => { mark = resolve; });
  return { wait, mark };
}

async function loaded(manager: SessionManager): Promise<SessionManager> {
  await manager.load();
  return manager;
}

describe("SDPPPX 临时图床来源声明", () => {
  it("稳定 ID、provider 类别、priority 10、图片/视频、20 MiB、不复制、未知有效期", () => {
    const exposer = exposerOf();
    expect(exposer.exposerId).toBe(SDPPPX_TEMPORARY_EXPOSER_ID);
    expect(exposer.exposerId).toBe("sdpppx-temporary");
    expect(exposer.label).toBe("SDPPPX 临时图床");
    expect(exposer.ownerExtensionId).toBe("sdpppx-provider");
    expect(exposer.requiresReplica).toBe(false);
    expect(exposer.temporaryHosting).toMatchObject({
      category: "provider",
      priority: 10,
      validitySeconds: null,
      constraints: { mediaKinds: ["image", "video"], maxBytes: 20 * 1024 * 1024 }
    });
  });

  it("就绪只看登录态，与模板目录无关；未登录时给出说明", async () => {
    const anonymous = exposerOf({ session: await loaded(managerOf(createMemorySessionStore())) });
    expect(anonymous.temporaryHosting?.ready?.()).toBe(false);
    expect(anonymous.temporaryHosting?.statusNote?.()).toBe("未登录 SDPPPX");

    const authenticated = exposerOf({ session: await loaded(managerOf()) });
    expect(authenticated.temporaryHosting?.ready?.()).toBe(true);
    expect(authenticated.temporaryHosting?.statusNote?.()).toBeNull();
  });
});

describe("SDPPPX 临时图床上传", () => {
  it("读稳定素材、上传、匿名核验后返回地址；不写回任何缓存", async () => {
    const upload = vi.fn(async () => uploadOk());
    const probe = vi.fn(probeOk);
    const exposer = exposerOf({ upload, probe });

    expect(await exposer.expose({ namespace: "media", key: "sha256-a.png" })).toBe(PUBLIC_URL);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ url: PUBLIC_URL, mediaType: "image/png" }));
    const first = upload.mock.calls[0] as unknown as [{ accessToken: string; baseUrl: string }];
    expect(first[0].accessToken).toBe("access-1");

    // 首版不建立跨请求地址缓存：第二次独立请求会重新上传。
    expect(await exposer.expose({ namespace: "media", key: "sha256-a.png" })).toBe(PUBLIC_URL);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("有正数有效窗口要求时明确拒绝，不发送上传", async () => {
    const upload = vi.fn(async () => uploadOk());
    const exposer = exposerOf({ upload });
    await expect(exposer.expose({
      namespace: "media",
      key: "sha256-a.png",
      request: { requiredValiditySeconds: 900 }
    })).rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.mediaInvalidResponse });
    await expect(exposer.expose({
      namespace: "media",
      key: "sha256-a.png",
      expiresSeconds: 900
    })).rejects.toThrow(/900 秒/);
    expect(upload).not.toHaveBeenCalled();
  });

  it("匿名读取失败不返回不可读地址，也不清登录态", async () => {
    const store = createMemorySessionStore(SESSION);
    const session = await loaded(managerOf(store));
    const exposer = exposerOf({
      session,
      upload: async () => uploadOk(),
      probe: async () => ({ ok: false as const, message: "匿名读取失败（HTTP 403）" })
    });
    await expect(exposer.expose({ namespace: "media", key: "sha256-a.png" })).rejects.toMatchObject({
      code: SDPPPX_ERROR_CODES.mediaNotReadable
    });
    expect(session.session()).not.toBeNull();
    expect(await store.load()).toMatchObject({ userId: "user-1" });
  });

  it("空素材、音频与超限在上传前拒绝", async () => {
    const upload = vi.fn(async () => uploadOk());
    const empty = exposerOf({
      objects: { "empty.png": { bytes: new Uint8Array(), contentType: "image/png" } },
      upload
    });
    await expect(empty.expose({ namespace: "media", key: "empty.png" }))
      .rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.mediaUnsupported });

    const audio = exposerOf({
      objects: { "voice.mp3": { bytes: PNG_BYTES, contentType: "audio/mpeg" } },
      upload
    });
    await expect(audio.expose({ namespace: "media", key: "voice.mp3" }))
      .rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.mediaUnsupported });
    expect(upload).not.toHaveBeenCalled();
  });

  it("上传 401 按既有会话失效路径清理；403 与匿名 403 不清登录态", async () => {
    const store = createMemorySessionStore(SESSION);
    const session = await loaded(managerOf(store));
    const unauthorized = exposerOf({
      session,
      upload: async () => ({ ok: false as const, status: 401, code: SDPPPX_ERROR_CODES.sessionExpired, message: "SDPPPX 会话已失效" })
    });
    await expect(unauthorized.expose({ namespace: "media", key: "sha256-a.png" }))
      .rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.sessionExpired });
    expect(session.session()).toBeNull();
    expect(await store.load()).toBeNull();

    const store2 = createMemorySessionStore(SESSION);
    const session2 = await loaded(managerOf(store2));
    const forbidden = exposerOf({
      session: session2,
      upload: async () => ({ ok: false as const, status: 403, code: SDPPPX_ERROR_CODES.mediaForbidden, message: "权限拒绝" })
    });
    await expect(forbidden.expose({ namespace: "media", key: "sha256-a.png" }))
      .rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.mediaForbidden });
    expect(session2.session()).not.toBeNull();
    expect(await store2.load()).toMatchObject({ userId: "user-1" });

    const store3 = createMemorySessionStore(SESSION);
    const session3 = await loaded(managerOf(store3));
    const anonymous403 = exposerOf({
      session: session3,
      upload: async () => uploadOk(),
      probe: async () => ({ ok: false as const, message: "匿名读取失败（HTTP 403）" })
    });
    await expect(anonymous403.expose({ namespace: "media", key: "sha256-a.png" })).rejects.toBeTruthy();
    expect(session3.session()).not.toBeNull();
  });

  it("稳定素材本身超过 20 MiB 时按存储统计直接拒绝，不读整段字节", async () => {
    const upload = vi.fn(async () => uploadOk());
    let reads = 0;
    const storage = {
      bucket: () => ({
        head: async () => ({ size: 20 * 1024 * 1024 + 1, contentType: "video/mp4" }),
        get: async () => {
          reads += 1;
          throw new Error("不该读取");
        }
      })
    } as unknown as HostStorageService;
    const exposer = createSdpppxTemporaryExposer({
      storage,
      config: () => readTestConfig(),
      session: await loaded(managerOf()),
      upload
    });
    await expect(exposer.expose({ namespace: "media", key: "sha256-big.mp4" }))
      .rejects.toMatchObject({ code: SDPPPX_ERROR_CODES.mediaUnsupported });
    expect(reads).toBe(0);
    expect(upload).not.toHaveBeenCalled();
  });

  it("日志只记录来源、阶段、状态码、错误码与字节数，不含令牌或完整下载 URL", async () => {
    const events: Array<Record<string, unknown>> = [];
    const storage = {
      bucket: () => ({
        head: async () => null,
        get: async () => ({ bytes: PNG_BYTES, contentType: "image/png" })
      })
    } as unknown as HostStorageService;
    const exposer = createSdpppxTemporaryExposer({
      storage,
      config: () => readTestConfig(),
      session: await loaded(managerOf()),
      upload: async () => uploadOk(`${PUBLIC_URL}?sign=secret-token`),
      probe: probeOk,
      log: (event) => events.push(event)
    });
    await exposer.expose({ namespace: "media", key: "sha256-a.png" });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("access-1");
    expect(events.map(event => event.event)).toContain("sdpppx-temporary-prepared");
    expect(events.find(event => event.event === "sdpppx-temporary-prepared")).toMatchObject({
      exposerId: "sdpppx-temporary",
      size: PNG_BYTES.byteLength
    });
  });

  it("缺少稳定素材时冒泡存储错误，不伪造地址", async () => {
    const exposer = exposerOf({ upload: async () => uploadOk() });
    await expect(exposer.expose({ namespace: "media", key: "gone.png" }))
      .rejects.toMatchObject({ code: "STORAGE_OBJECT_NOT_FOUND" });
  });

  it("失败清除进行中项：下一次独立请求重新上传", async () => {
    let attempts = 0;
    const exposer = exposerOf({
      upload: async () => {
        attempts += 1;
        return attempts === 1
          ? { ok: false as const, status: 503, code: SDPPPX_ERROR_CODES.mediaUploadUnavailable, message: "上游 503" }
          : uploadOk();
      }
    });
    await expect(exposer.expose({ namespace: "media", key: "sha256-a.png" })).rejects.toThrow(/503/);
    expect(await exposer.expose({ namespace: "media", key: "sha256-a.png" })).toBe(PUBLIC_URL);
    expect(attempts).toBe(2);
  });
});

describe("SDPPPX 临时图床并发与授权隔离", () => {
  it("同一画布/内容/账号并发只上传一次，一个等待者取消不影响另一个", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const upload = vi.fn(async () => {
      await gate;
      return uploadOk();
    });
    const exposer = exposerOf({ upload });

    const cancelled = new AbortController();
    const first = exposer.expose({
      namespace: "media",
      key: "sha256-a.png",
      scope: { canvasId: "c1" },
      request: { signal: cancelled.signal }
    });
    const second = exposer.expose({ namespace: "media", key: "sha256-a.png", scope: { canvasId: "c1" } });
    cancelled.abort();
    await expect(first).rejects.toThrow(/取消/);
    release!();
    expect(await second).toBe(PUBLIC_URL);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("不同画布不共享上传", async () => {
    const upload = vi.fn(async () => uploadOk());
    const exposer = exposerOf({ upload });
    await Promise.all([
      exposer.expose({ namespace: "media", key: "sha256-a.png", scope: { canvasId: "c1" } }),
      exposer.expose({ namespace: "media", key: "sha256-a.png", scope: { canvasId: "c2" } })
    ]);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("上传期间换号时丢弃迟到结果", async () => {
    const store = createMemorySessionStore(SESSION);
    const session = await loaded(managerOf(store));
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const begun = started();
    const exposer = exposerOf({
      session,
      upload: async () => {
        begun.mark();
        await gate;
        return uploadOk();
      }
    });
    const pending = exposer.expose({ namespace: "media", key: "sha256-a.png" });
    await begun.wait;
    // 登出后再登录另一个账号：授权代次递增，旧结果不得返回。
    await session.clear(null);
    await session.set({ ...SESSION, accessToken: "access-2", refreshToken: "refresh-2", userId: "user-2" });
    release!();
    await expect(pending).rejects.toMatchObject({ code: "STORAGE_EXPOSE_STALE" });
  });

  it("上传期间登出时同样丢弃结果", async () => {
    const store = createMemorySessionStore(SESSION);
    const session = await loaded(managerOf(store));
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const begun = started();
    const exposer = exposerOf({
      session,
      upload: async () => {
        begun.mark();
        await gate;
        return uploadOk();
      }
    });
    const pending = exposer.expose({ namespace: "media", key: "sha256-a.png" });
    await begun.wait;
    await session.clear(SDPPPX_ERROR_CODES.sessionExpired);
    release!();
    await expect(pending).rejects.toMatchObject({ code: "STORAGE_EXPOSE_STALE" });
  });

  it("正常同账号 token 续期不算换号：不因核心冻结的代次而必然 stale", async () => {
    const store = createMemorySessionStore({ ...SESSION, expiresAt: NOW + 10_000 });
    const { fetchImpl } = createFetch(() =>
      jsonResponse({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600, user: { id: "user-1" } })
    );
    const session = managerOf(store, fetchImpl);
    const exposer = exposerOf({ session, upload: async () => uploadOk() });
    expect(await exposer.expose({ namespace: "media", key: "sha256-a.png" })).toBe(PUBLIC_URL);
    expect(session.session()?.accessToken).toBe("access-2");
    // 续期不递增授权代次。
    expect(session.epoch()).toBe(0);
  });

  it("来源撤销：dispose 后中止进行中上传并拒绝新请求", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const exposer = exposerOf({ upload: async () => { await gate; return uploadOk(); } });
    const pending = exposer.expose({ namespace: "media", key: "sha256-a.png" });
    exposer.dispose();
    release!();
    await expect(pending).rejects.toBeTruthy();
    await expect(exposer.expose({ namespace: "media", key: "sha256-a.png" }))
      .rejects.toMatchObject({ code: "STORAGE_EXPOSE_STALE" });
    expect(exposer.temporaryHosting?.ready?.()).toBe(false);
  });
});
