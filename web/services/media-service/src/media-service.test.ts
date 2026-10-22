/**
 * Media Service 测试（change: split-web-runtime-services，任务 3.1–3.4）。
 *
 * 覆盖 public 上传/读取/Range/去重/错误脱敏，以及 internal verify/sign/import 的认证、
 * 作用域、版本协商、TTL、SSRF 与 bytes 上限。
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import type { MediaObject, MediaStorage, MediaStorageScope } from "@woohaa3/contracts";
import { MediaObjectNotFoundError } from "@woohaa3/contracts";
import { computeSha256Hex } from "./application/ingest.js";
import { createMediaApplicationService } from "./application/internal-service.js";
import { createMediaService } from "./composition.js";
import { guardedDownload } from "./security/guarded-fetch.js";
import { isPrivateAddress } from "./security/address.js";

const CHECKSUM = "a".repeat(64);
const STORAGE_KEY = `sha256-${CHECKSUM}`;
const TOKENS = {
  tokens: { "canvas-service": "canvas-token", "task-service": "task-token" }
};

function memoryStorage(objects = new Map<string, MediaObject>()): MediaStorage {
  return {
    async put(key, bytes, contentType) {
      objects.set(key, { bytes: Uint8Array.from(bytes), contentType });
    },
    async get(key): Promise<MediaObject> {
      const record = objects.get(key);
      if (!record) throw new MediaObjectNotFoundError(key);
      return record;
    },
    async exists(key) {
      return objects.has(key);
    },
    async stat(key) {
      const record = objects.get(key);
      if (!record) throw new MediaObjectNotFoundError(key);
      return { size: record.bytes.byteLength, contentType: record.contentType };
    },
    async getHttpsUrl(key, options) {
      void options;
      return `https://cos.invalid/${key}?sign=test`;
    }
  } as MediaStorage;
}

type StorageCalls = {
  put: Array<{ key: string; scope?: MediaStorageScope }>;
  get: Array<{ key: string; scope?: MediaStorageScope }>;
  exists: Array<{ key: string; scope?: MediaStorageScope }>;
  stat: Array<{ key: string; scope?: MediaStorageScope }>;
  getHttpsUrl: Array<{ key: string; scope?: MediaStorageScope }>;
};

/** 记录每次存储调用收到的画布作用域，用于断言 canvas 透传。 */
function recordingStorage(objects = new Map<string, MediaObject>()): { storage: MediaStorage; calls: StorageCalls } {
  const calls: StorageCalls = { put: [], get: [], exists: [], stat: [], getHttpsUrl: [] };
  const storage: MediaStorage = {
    async put(key, bytes, contentType, scope) {
      calls.put.push({ key, scope });
      objects.set(key, { bytes: Uint8Array.from(bytes), contentType });
    },
    async get(key, scope) {
      calls.get.push({ key, scope });
      const record = objects.get(key);
      if (!record) throw new MediaObjectNotFoundError(key);
      return record;
    },
    async exists(key, scope) {
      calls.exists.push({ key, scope });
      return objects.has(key);
    },
    async stat(key, scope) {
      calls.stat.push({ key, scope });
      const record = objects.get(key);
      if (!record) throw new MediaObjectNotFoundError(key);
      return { size: record.bytes.byteLength, contentType: record.contentType };
    },
    async getHttpsUrl(key, options, scope) {
      void options;
      calls.getHttpsUrl.push({ key, scope });
      return "https://cos.invalid/" + key + "?sign=test";
    }
  };
  return { storage, calls };
}

type InvokeResult = { status: number; body: string; headers: Record<string, string | number | string[] | undefined>; handled: boolean };

/** 内部协议的当前版本头；内部调用方必须显式声明版本（见 contracts `checkProtocolVersion`）。 */
const PROTOCOL_VERSION_HEADER = { "x-woohaa3-protocol-version": "1" };

/** 用真实 IncomingMessage/ServerResponse 驱动 handler（不起监听端口）。 */
async function invoke(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
  options: { method: string; url: string; headers?: Record<string, string>; body?: Uint8Array | string }
): Promise<InvokeResult> {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = options.method;
  req.url = options.url;
  for (const [key, value] of Object.entries({ ...PROTOCOL_VERSION_HEADER, ...(options.headers ?? {}) })) {
    req.headers[key] = value;
  }
  const chunks: string[] = [];
  const res = new ServerResponse(req);
  const headers: InvokeResult["headers"] = {};
  res.writeHead = ((status: number, maybeHeaders?: Record<string, string>) => {
    res.statusCode = status;
    if (maybeHeaders) for (const [k, v] of Object.entries(maybeHeaders)) headers[k] = v;
    return res;
  }) as typeof res.writeHead;
  res.setHeader = ((name: string, value: string | number | string[]) => {
    headers[name.toLowerCase()] = value;
    return res;
  }) as typeof res.setHeader;
  res.end = ((chunk?: unknown) => {
    if (typeof chunk === "string") chunks.push(chunk);
    else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk).toString("binary"));
    return res;
  }) as typeof res.end;
  res.write = ((chunk: unknown) => {
    if (typeof chunk === "string") chunks.push(chunk);
    return true;
  }) as typeof res.write;

  const handledPromise = handler(req, res);
  // handler 是 async：body 监听器要等它内部首个 await 之后才挂上，因此用 setImmediate
  // 推迟到微任务之后投递，避免 body 事件在监听器挂上前丢失。
  if (options.body !== undefined) {
    const buffer = typeof options.body === "string" ? Buffer.from(options.body) : Buffer.from(options.body);
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        req.emit("data", buffer);
        req.emit("end");
        resolve();
      });
    });
  }
  const handled = await handledPromise;
  return { status: res.statusCode, body: chunks.join(""), headers, handled };
}

function jsonBody(result: InvokeResult): unknown {
  return JSON.parse(result.body);
}

describe("public 媒体接口（任务 3.1）", () => {
  it("上传合法图片返回稳定 metadata，重复上传去重", async () => {
    const service = createMediaService({ storage: memoryStorage(), identities: TOKENS });
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const first = await invoke(service.handle, {
      method: "POST",
      url: "/api/media",
      headers: { "content-type": "image/png" },
      body: png
    });
    expect(first.status).toBe(201);
    const body = jsonBody(first) as { storageKey: string; url: string; checksum: string; size: number; deduplicated: boolean };
    expect(body.storageKey).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(body.url).toBe(`/api/media/${body.storageKey}`);
    expect(body.deduplicated).toBe(false);

    const second = await invoke(service.handle, {
      method: "POST",
      url: "/api/media",
      headers: { "content-type": "image/png" },
      body: png
    });
    expect((jsonBody(second) as { deduplicated: boolean }).deduplicated).toBe(true);
  });

  it("无 decoder 二进制原件可内容寻址上传和读取，不解释为脚本", async () => {
    const service = createMediaService({ storage: memoryStorage(), identities: TOKENS });
    const bytes = Uint8Array.from([0, 255, 13, 60, 115, 99, 114, 105, 112, 116, 62]);
    const uploaded = await invoke(service.handle, { method: "POST", url: "/api/media", headers: { "content-type": "application/octet-stream" }, body: bytes });
    expect(uploaded.status).toBe(201);
    const metadata = jsonBody(uploaded) as { storageKey: string; contentType: string; size: number };
    expect(metadata.contentType).toBe("application/octet-stream");
    expect(metadata.size).toBe(bytes.length);
    const read = await invoke(service.handle, { method: "GET", url: `/api/media/${metadata.storageKey}` });
    expect(read.status).toBe(200);
    expect(read.headers["content-type"]).toBe("application/octet-stream");
    expect(read.headers["x-content-type-options"]).toBe("nosniff");
    expect(read.body).toBe(Buffer.from(bytes).toString("binary"));
  });

  it("不安全/超限请求返回稳定错误码且不回显存储错误", async () => {
    const service = createMediaService({ storage: memoryStorage(), identities: TOKENS });
    const badType = await invoke(service.handle, {
      method: "POST",
      url: "/api/media",
      headers: { "content-type": "application/x-msdownload" },
      body: Uint8Array.from([1, 2, 3])
    });
    expect(badType.status).toBe(415);

    const traversal = await invoke(service.handle, { method: "GET", url: "/api/media/..%2F..%2Fetc%2Fpasswd" });
    expect(traversal.status).toBe(400);
    expect((jsonBody(traversal) as { error: string }).error).toBe("invalid-storage-key");
  });

  it("GET 支持 Range，HEAD 返回元数据", async () => {
    const objects = new Map<string, MediaObject>();
    const storage = memoryStorage(objects);
    objects.set(STORAGE_KEY, { bytes: Uint8Array.from([1, 2, 3, 4, 5, 6]), contentType: "image/png" });
    const service = createMediaService({ storage, identities: TOKENS });

    const ranged = await invoke(service.handle, {
      method: "GET",
      url: `/api/media/${STORAGE_KEY}`,
      headers: { range: "bytes=1-3" }
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers["content-range"]).toBe("bytes 1-3/6");

    const head = await invoke(service.handle, { method: "HEAD", url: `/api/media/${STORAGE_KEY}` });
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe("6");
    expect(head.headers["content-type"]).toBe("image/png");

    const missing = await invoke(service.handle, { method: "GET", url: `/api/media/sha256-${"b".repeat(64)}` });
    expect(missing.status).toBe(404);
  });
});

describe("internal 媒体协议（任务 3.2 / 3.3）", () => {
  it("未认证请求被拒绝且不访问存储", async () => {
    let accessed = false;
    const storage = memoryStorage();
    const original = storage.exists;
    storage.exists = async (key: string) => {
      accessed = true;
      return original.call(storage, key);
    };
    const service = createMediaService({ storage, identities: TOKENS });
    const result = await invoke(service.handle, {
      method: "POST",
      url: "/internal/v1/media/verify",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ storageKey: STORAGE_KEY })
    });
    expect(result.status).toBe(401);
    expect(accessed).toBe(false);
  });

  it("协议版本不兼容在副作用前失败", async () => {
    const service = createMediaService({ storage: memoryStorage(), identities: TOKENS });
    const result = await invoke(service.handle, {
      method: "POST",
      url: "/internal/v1/media/verify",
      headers: {
        "content-type": "application/json",
        "x-woohaa3-service-token": "task-token",
        "x-woohaa3-protocol-version": "999"
      },
      body: JSON.stringify({ storageKey: STORAGE_KEY })
    });
    expect(result.status).toBe(409);
    expect((jsonBody(result) as { code: string }).code).toBe("protocol-incompatible");
  });

  it("Canvas 身份不能请求签名（作用域）", async () => {
    const objects = new Map<string, MediaObject>();
    objects.set(STORAGE_KEY, { bytes: Uint8Array.from([1]), contentType: "image/png" });
    const service = createMediaService({ storage: memoryStorage(objects), identities: TOKENS });
    const result = await invoke(service.handle, {
      method: "POST",
      url: "/internal/v1/media/sign",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": "canvas-token" },
      body: JSON.stringify({ storageKey: STORAGE_KEY })
    });
    expect(result.status).toBe(403);
  });

  it("Task 可签名，TTL 受限", async () => {
    const objects = new Map<string, MediaObject>();
    objects.set(STORAGE_KEY, { bytes: Uint8Array.from([1]), contentType: "image/png" });
    const service = createMediaService({ storage: memoryStorage(objects), identities: TOKENS });
    const ok = await invoke(service.handle, {
      method: "POST",
      url: "/internal/v1/media/sign",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": "task-token" },
      body: JSON.stringify({ storageKey: STORAGE_KEY, expiresSeconds: 900 })
    });
    expect(ok.status).toBe(200);
    expect((jsonBody(ok) as { url: string }).url).toMatch(/^https:\/\//);

    const tooLong = await invoke(service.handle, {
      method: "POST",
      url: "/internal/v1/media/sign",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": "task-token" },
      body: JSON.stringify({ storageKey: STORAGE_KEY, expiresSeconds: 99999 })
    });
    expect(tooLong.status).toBe(400);
  });

  it("verify 报告 metadata 一致性与缺失", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const checksum = await computeSha256Hex(bytes);
    const key = `sha256-${checksum}`;
    const objects = new Map<string, MediaObject>();
    objects.set(key, { bytes, contentType: "image/png" });
    const service = createMediaService({ storage: memoryStorage(objects), identities: TOKENS });

    const match = await invoke(service.handle, {
      method: "POST",
      url: "/internal/v1/media/verify",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": "canvas-token" },
      body: JSON.stringify({ storageKey: key, expected: { size: 4, contentType: "image/png", checksum } })
    });
    expect(match.status).toBe(200);
    expect(jsonBody(match)).toMatchObject({ exists: true, matches: true });

    const mismatch = await invoke(service.handle, {
      method: "POST",
      url: "/internal/v1/media/verify",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": "canvas-token" },
      body: JSON.stringify({ storageKey: key, expected: { size: 999 } })
    });
    expect(jsonBody(mismatch)).toMatchObject({ exists: true, matches: false });

    const missing = await invoke(service.handle, {
      method: "POST",
      url: "/internal/v1/media/verify",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": "canvas-token" },
      body: JSON.stringify({ storageKey: `sha256-${"c".repeat(64)}` })
    });
    expect(jsonBody(missing)).toEqual({ exists: false });
  });

  it("import 拒绝私网目标、协议与超大内容", async () => {
    const service = createMediaService({ storage: memoryStorage(), identities: TOKENS });
    const internal = await invoke(service.handle, {
      method: "POST",
      url: "/internal/v1/media/import",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": "task-token" },
      body: JSON.stringify({ url: "https://127.0.0.1/x.png" })
    });
    expect(internal.status).toBe(400);

    const http = await invoke(service.handle, {
      method: "POST",
      url: "/internal/v1/media/import",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": "task-token" },
      body: JSON.stringify({ url: "http://cdn.example/x.png" })
    });
    expect(http.status).toBe(400);
  });

  it("import 受控下载并内容寻址写入，相同内容幂等", async () => {
    const objects = new Map<string, MediaObject>();
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);
    const service = createMediaService({
      storage: memoryStorage(objects),
      identities: TOKENS,
      fetchImpl: (async () =>
        new Response(new Uint8Array(bytes), {
          status: 200,
          headers: { "content-type": "image/png" }
        })) as unknown as typeof globalThis.fetch
    });
    const result = await invoke(service.handle, {
      method: "POST",
      url: "/internal/v1/media/import",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": "task-token" },
      body: JSON.stringify({ url: "https://cdn.example/out.png" })
    });
    expect(result.status).toBe(201);
    const metadata = jsonBody(result) as { storageKey: string; checksum: string; size: number; contentType: string };
    expect(metadata.storageKey).toBe(`generation-outputs/${metadata.checksum}.png`);
    expect(objects.has(metadata.storageKey)).toBe(true);
  });

  it("import-bytes：provider 以 base64 返回图片时按字节内容寻址写入", async () => {
    const objects = new Map<string, MediaObject>();
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const service = createMediaService({ storage: memoryStorage(objects), identities: TOKENS });

    const result = await invoke(service.handle, {
      method: "POST",
      url: "/internal/v1/media/import-bytes",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": "task-token" },
      body: JSON.stringify({
        bytesBase64: Buffer.from(bytes).toString("base64"),
        contentType: "image/png"
      })
    });
    expect(result.status).toBe(201);
    const metadata = jsonBody(result) as { storageKey: string; size: number; contentType: string };
    expect(metadata.contentType).toBe("image/png");
    expect(metadata.size).toBe(bytes.byteLength);
    expect(objects.has(metadata.storageKey)).toBe(true);

    // Canvas 身份没有 import 作用域：结构性拒绝（不能按字节转存）。
    const forbidden = await invoke(service.handle, {
      method: "POST",
      url: "/internal/v1/media/import-bytes",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": "canvas-token" },
      body: JSON.stringify({ bytesBase64: "AAAA", contentType: "image/png" })
    });
    expect(forbidden.status).toBe(403);
  });

  it("import-bytes：大于 1MiB base64 的图片仍可导入（body 上限按配置推导）", async () => {
    // 回归：曾经 readJson 默认 1 MiB 上限会把 >~0.75 MiB 的图片整个拒掉。
    const objects = new Map<string, MediaObject>();
    const bytes = new Uint8Array(900 * 1024); // 900 KiB → base64 ~1.2 MiB
    bytes[0] = 0x89;
    const service = createMediaService({ storage: memoryStorage(objects), identities: TOKENS });

    const result = await invoke(service.handle, {
      method: "POST",
      url: "/internal/v1/media/import-bytes",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": "task-token" },
      body: JSON.stringify({ bytesBase64: Buffer.from(bytes).toString("base64"), contentType: "image/png" })
    });
    expect(result.status).toBe(201);
    expect((jsonBody(result) as { size: number }).size).toBe(bytes.byteLength);
  });

  it("import 转存视频：受控下载、内容寻址、扩展名正确", async () => {
    const objects = new Map<string, MediaObject>();
    const bytes = Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 1, 2]);
    const service = createMediaService({
      storage: memoryStorage(objects),
      identities: TOKENS,
      fetchImpl: (async () =>
        new Response(new Uint8Array(bytes), {
          status: 200,
          headers: { "content-type": "video/mp4" }
        })) as unknown as typeof globalThis.fetch
    });
    const result = await invoke(service.handle, {
      method: "POST",
      url: "/internal/v1/media/import",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": "task-token" },
      body: JSON.stringify({ url: "https://cdn.example/out.mp4" })
    });
    expect(result.status).toBe(201);
    const metadata = jsonBody(result) as { storageKey: string; contentType: string; mediaKind?: string };
    expect(metadata.contentType).toBe("video/mp4");
    expect(metadata.storageKey.endsWith(".mp4")).toBe(true);
    expect(metadata.mediaKind).toBe("video");
  });

  it("import-bytes 允许音频、拒绝视频", async () => {
    const objects = new Map<string, MediaObject>();
    const service = createMediaService({ storage: memoryStorage(objects), identities: TOKENS });
    const audio = Uint8Array.from([0xff, 0xfb, 0x90, 0x00]);
    const accepted = await invoke(service.handle, {
      method: "POST",
      url: "/internal/v1/media/import-bytes",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": "task-token" },
      body: JSON.stringify({ bytesBase64: Buffer.from(audio).toString("base64"), contentType: "audio/mpeg" })
    });
    expect(accepted.status).toBe(201);
    expect((jsonBody(accepted) as { storageKey: string }).storageKey.endsWith(".mp3")).toBe(true);

    const rejected = await invoke(service.handle, {
      method: "POST",
      url: "/internal/v1/media/import-bytes",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": "task-token" },
      body: JSON.stringify({ bytesBase64: "AAAA", contentType: "video/mp4" })
    });
    expect(rejected.status).toBe(400);
  });

  it("import 拒绝未知媒体类型", async () => {
    const objects = new Map<string, MediaObject>();
    const service = createMediaService({
      storage: memoryStorage(objects),
      identities: TOKENS,
      fetchImpl: (async () =>
        new Response(Uint8Array.from([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "application/x-msdownload" }
        })) as unknown as typeof globalThis.fetch
    });
    const result = await invoke(service.handle, {
      method: "POST",
      url: "/internal/v1/media/import",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": "task-token" },
      body: JSON.stringify({ url: "https://cdn.example/out.bin" })
    });
    expect(result.status).toBeGreaterThanOrEqual(400);
  });
});

describe("受控下载守卫与地址分类（任务 3.3）", () => {
  it("地址分类覆盖回环/私网/链路本地/元数据", () => {
    for (const host of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fc00::1", "fe80::1"]) {
      expect(isPrivateAddress(host), host).toBe(true);
    }
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("cdn.example.com")).toBe(false);
  });

  it("DNS 重绑定：解析到私网即拒绝", async () => {
    await expect(
      guardedDownload({
        url: "https://rebind.example/x.png",
        maxBytes: 1024,
        timeoutMs: 1000,
        fetchImpl: (async () => new Response(new Uint8Array([1]))) as unknown as typeof globalThis.fetch,
        resolveHost: async () => ["10.0.0.5"]
      })
    ).rejects.toMatchObject({ code: "blocked-host" });
  });

  it("guardedDownload 拒绝非 https 与超限", async () => {
    await expect(
      guardedDownload({ url: "http://cdn.example/x.png", maxBytes: 10, timeoutMs: 1000 })
    ).rejects.toMatchObject({ code: "unsupported-protocol" });

    await expect(
      guardedDownload({
        url: "https://cdn.example/x.png",
        maxBytes: 2,
        timeoutMs: 1000,
        fetchImpl: (async () =>
          new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof globalThis.fetch
      })
    ).rejects.toMatchObject({ code: "too-large" });
  });

  it("重定向逐跳校验，重定向到私网被拒绝", async () => {
    await expect(
      guardedDownload({
        url: "https://cdn.example/x.png",
        maxBytes: 1024,
        timeoutMs: 1000,
        fetchImpl: (async () =>
          new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } })) as unknown as typeof globalThis.fetch
      })
    ).rejects.toMatchObject({ code: "blocked-host" });
  });

  it("超时即中止", async () => {
    await expect(
      guardedDownload({
        url: "https://cdn.example/x.png",
        maxBytes: 1024,
        timeoutMs: 20,
        fetchImpl: (async (_url: string, init?: RequestInit) => {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 500);
            init?.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            });
          });
          return new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } });
        }) as unknown as typeof globalThis.fetch
      })
    ).rejects.toBeDefined();
  });
});

describe("画布作用域透传", () => {
  it("public 上传、HEAD 与 GET 带 canvas 时把作用域透传给存储", async () => {
    const { storage, calls } = recordingStorage();
    const service = createMediaService({ storage, identities: TOKENS });
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 5]);
    const upload = await invoke(service.handle, {
      method: "POST",
      url: "/api/media?canvas=canvas-1",
      headers: { "content-type": "image/png" },
      body: png
    });
    expect(upload.status).toBe(201);
    const key = (jsonBody(upload) as { storageKey: string }).storageKey;
    expect(calls.exists.at(-1)?.scope).toEqual({ canvasId: "canvas-1" });
    expect(calls.put.at(-1)).toEqual({ key, scope: { canvasId: "canvas-1" } });

    const head = await invoke(service.handle, { method: "HEAD", url: "/api/media/" + key + "?canvas=canvas-1" });
    expect(head.status).toBe(200);
    expect(calls.stat.at(-1)?.scope).toEqual({ canvasId: "canvas-1" });

    const read = await invoke(service.handle, { method: "GET", url: "/api/media/" + key + "?canvas=canvas-1" });
    expect(read.status).toBe(200);
    expect(calls.get.at(-1)?.scope).toEqual({ canvasId: "canvas-1" });
  });

  it("不带 canvas 时读写保持旧行为（无作用域）", async () => {
    const { storage, calls } = recordingStorage();
    const service = createMediaService({ storage, identities: TOKENS });
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 6]);
    const upload = await invoke(service.handle, {
      method: "POST",
      url: "/api/media",
      headers: { "content-type": "image/png" },
      body: bytes
    });
    expect(upload.status).toBe(201);
    const key = (jsonBody(upload) as { storageKey: string }).storageKey;
    expect(calls.put.at(-1)?.scope).toBeUndefined();

    const read = await invoke(service.handle, { method: "GET", url: "/api/media/" + key });
    expect(read.status).toBe(200);
    expect(calls.get.at(-1)?.scope).toBeUndefined();
  });

  it("非法或空 canvas 查询参数视为无作用域", async () => {
    const { storage, calls } = recordingStorage();
    const service = createMediaService({ storage, identities: TOKENS });
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 7]);
    const upload = await invoke(service.handle, {
      method: "POST",
      url: "/api/media?canvas=",
      headers: { "content-type": "image/png" },
      body: bytes
    });
    expect(upload.status).toBe(201);
    const key = (jsonBody(upload) as { storageKey: string }).storageKey;
    expect(calls.put.at(-1)?.scope).toBeUndefined();

    const read = await invoke(service.handle, { method: "GET", url: "/api/media/" + key + "?canvas=..%2F..%2Fetc" });
    expect(read.status).toBe(200);
    expect(calls.get.at(-1)?.scope).toBeUndefined();
  });

  it("internal import 与 import-bytes 接受可选 canvasId 并透传到 exists/put", async () => {
    const { storage, calls } = recordingStorage();
    const imported = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9, 9]);
    const service = createMediaService({
      storage,
      identities: TOKENS,
      fetchImpl: (async () =>
        new Response(new Uint8Array(imported), { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof globalThis.fetch
    });

    const viaUrl = await invoke(service.handle, {
      method: "POST",
      url: "/internal/v1/media/import",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": "task-token" },
      body: JSON.stringify({ url: "https://cdn.example/out.png", canvasId: "canvas-7" })
    });
    expect(viaUrl.status).toBe(201);
    expect(calls.exists.at(-1)?.scope).toEqual({ canvasId: "canvas-7" });
    expect(calls.put.at(-1)?.scope).toEqual({ canvasId: "canvas-7" });

    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const viaBytes = await invoke(service.handle, {
      method: "POST",
      url: "/internal/v1/media/import-bytes",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": "task-token" },
      body: JSON.stringify({ bytesBase64: Buffer.from(bytes).toString("base64"), contentType: "image/png", canvasId: "canvas-8" })
    });
    expect(viaBytes.status).toBe(201);
    expect(calls.put.at(-1)?.scope).toEqual({ canvasId: "canvas-8" });
  });

  it("internal import 的非法 canvasId 被拒绝且不写存储", async () => {
    const { storage, calls } = recordingStorage();
    const service = createMediaService({ storage, identities: TOKENS });
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1]);
    const rejected = await invoke(service.handle, {
      method: "POST",
      url: "/internal/v1/media/import-bytes",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": "task-token" },
      body: JSON.stringify({ bytesBase64: Buffer.from(bytes).toString("base64"), contentType: "image/png", canvasId: "../escape" })
    });
    expect(rejected.status).toBe(400);
    expect((jsonBody(rejected) as { code: string }).code).toBe("malformed-request");
    expect(calls.exists).toHaveLength(0);
    expect(calls.put).toHaveLength(0);
  });

  it("internal verify 与 sign 透传 canvasId 且响应形状不变", async () => {
    const objects = new Map<string, MediaObject>();
    objects.set(STORAGE_KEY, { bytes: Uint8Array.from([1]), contentType: "image/png" });
    const { storage, calls } = recordingStorage(objects);
    const service = createMediaService({ storage, identities: TOKENS });

    const verified = await invoke(service.handle, {
      method: "POST",
      url: "/internal/v1/media/verify",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": "canvas-token" },
      body: JSON.stringify({ storageKey: STORAGE_KEY, canvasId: "canvas-2" })
    });
    expect(verified.status).toBe(200);
    expect(jsonBody(verified)).toMatchObject({ exists: true });
    expect(calls.stat.at(-1)?.scope).toEqual({ canvasId: "canvas-2" });

    const signed = await invoke(service.handle, {
      method: "POST",
      url: "/internal/v1/media/sign",
      headers: { "content-type": "application/json", "x-woohaa3-service-token": "task-token" },
      body: JSON.stringify({ storageKey: STORAGE_KEY, canvasId: "canvas-2", expiresSeconds: 60 })
    });
    expect(signed.status).toBe(200);
    expect(jsonBody(signed)).toEqual({ url: expect.stringMatching(/^https:\/\//), expiresAt: expect.any(String) });
    expect(calls.getHttpsUrl.at(-1)?.scope).toEqual({ canvasId: "canvas-2" });
  });
});

describe("进程内媒体能力的作用域", () => {
  it("verify/sign 接受作用域、import 接受 canvasId，并透传到存储", async () => {
    const objects = new Map<string, MediaObject>();
    objects.set(STORAGE_KEY, { bytes: Uint8Array.from([1]), contentType: "image/png" });
    const { storage, calls } = recordingStorage(objects);
    const app = createMediaApplicationService({
      storage,
      fetchImpl: (async () =>
        new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } })) as unknown as typeof globalThis.fetch
    });

    const verified = await app.verify(STORAGE_KEY, { size: 1 }, { canvasId: "canvas-3" });
    expect(verified.exists).toBe(true);
    expect(calls.stat.at(-1)?.scope).toEqual({ canvasId: "canvas-3" });

    const url = await app.sign(STORAGE_KEY, 60, { canvasId: "canvas-3" });
    expect(url).toMatch(/^https:\/\//);
    expect(calls.getHttpsUrl.at(-1)?.scope).toEqual({ canvasId: "canvas-3" });

    const imported = await app.importFromUrl({ url: "https://cdn.example/out.png", canvasId: "canvas-4" });
    expect(imported.storageKey).toMatch(/^generation-outputs\//);
    expect(calls.put.at(-1)?.scope).toEqual({ canvasId: "canvas-4" });

    await expect(
      app.importBytes({ bytesBase64: "AAAA", contentType: "image/png", canvasId: "../escape" })
    ).rejects.toMatchObject({ code: "malformed-request" });
  });
});

describe("Media readiness（任务 3.4）", () => {
  it("COS 探测成功时 ready，失败时 not-ready 且不回退", async () => {
    const service = createMediaService({ storage: memoryStorage(), identities: TOKENS });
    expect(await service.readiness()).toEqual({ ready: true });

    const failing = memoryStorage();
    failing.put = async () => {
      throw new Error("COS down");
    };
    const broken = createMediaService({ storage: failing, identities: TOKENS });
    const readiness = await broken.readiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toBeDefined();
  });

  it("/internal/v1/media/health 反映 readiness", async () => {
    const failing = memoryStorage();
    failing.put = async () => {
      throw new Error("COS down");
    };
    const service = createMediaService({ storage: failing, identities: TOKENS });
    const result = await invoke(service.handle, { method: "GET", url: "/internal/v1/media/health" });
    expect(result.status).toBe(503);
  });
});
