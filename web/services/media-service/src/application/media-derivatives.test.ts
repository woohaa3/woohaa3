/**
 * 预览派生物的有界生成与受控读取
 * （change: 2026-10-23-scale-canvas-media-residency，design D4 / 任务 4.1-4.2）。
 *
 * 覆盖：同 key 合并、冷请求有界并发+排队、缓存命中仍验证授权、非法身份/超限在访问存储前
 * 拒绝、失败不写缓存且可重试、预算淘汰（不支持 delete 时不做假淘汰）、按作用域隔离。
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import {
  MediaObjectNotFoundError,
  mediaDerivativeCacheKey,
  type MediaObject,
  type MediaStorage,
  type MediaStorageScope
} from "@woohaa3/contracts";
import { createMediaRequestHandler } from "../api/public-handler.js";
import {
  MediaDerivativeError,
  createMediaDerivatives,
  type MediaDerivativeGenerateInput
} from "./media-derivatives.js";

const CHECKSUM = "b".repeat(64);
const SOURCE_KEY = `sha256-${CHECKSUM}`;
const SOURCE_BYTES = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);

type Calls = {
  get: Array<{ key: string; scope?: MediaStorageScope }>;
  put: Array<{ key: string; scope?: MediaStorageScope }>;
  stat: Array<{ key: string; scope?: MediaStorageScope }>;
  delete: Array<{ key: string; scope?: MediaStorageScope }>;
};

function memoryStorage(
  objects = new Map<string, MediaObject>(),
  options: { deletable?: boolean; deny?: (key: string, scope?: MediaStorageScope) => boolean } = {}
): { storage: MediaStorage; calls: Calls; objects: Map<string, MediaObject> } {
  const calls: Calls = { get: [], put: [], stat: [], delete: [] };
  const deny = options.deny ?? (() => false);
  const storage: MediaStorage = {
    async put(key, bytes, contentType, scope) {
      if (deny(key, scope)) throw new Error("storage denied");
      calls.put.push({ key, scope });
      objects.set(key, { bytes: Uint8Array.from(bytes), contentType });
    },
    async get(key, scope) {
      calls.get.push({ key, scope });
      if (deny(key, scope)) throw new MediaObjectNotFoundError(key);
      const record = objects.get(key);
      if (!record) throw new MediaObjectNotFoundError(key);
      return record;
    },
    async exists(key, scope) {
      if (deny(key, scope)) return false;
      return objects.has(key);
    },
    async stat(key, scope) {
      calls.stat.push({ key, scope });
      if (deny(key, scope)) throw new MediaObjectNotFoundError(key);
      const record = objects.get(key);
      if (!record) throw new MediaObjectNotFoundError(key);
      return { size: record.bytes.byteLength, contentType: record.contentType };
    }
  };
  if (options.deletable !== false) {
    storage.delete = async (key, scope) => {
      calls.delete.push({ key, scope });
      objects.delete(key);
    };
  }
  return { storage, calls, objects };
}

function sourceObjects(bytes = SOURCE_BYTES): Map<string, MediaObject> {
  return new Map([[SOURCE_KEY, { bytes, contentType: "image/png" }]]);
}

const IDENTITY = { sourceKey: SOURCE_KEY, kind: "thumbnail" as const, edge: 256 as const, format: "webp" as const };
const CACHE_KEY = mediaDerivativeCacheKey(IDENTITY)!;

describe("media derivatives", () => {
  it("同 key 与同档位合并为一次转换，不同节点/展示 URL 不产生新缓存项", async () => {
    const { storage, objects } = memoryStorage(sourceObjects());
    let conversions = 0;
    const derivatives = createMediaDerivatives({
      storage,
      generator: async () => {
        conversions++;
        return { bytes: Uint8Array.from([9, 9]), contentType: "image/webp", width: 200, height: 100 };
      },
      limits: { waitMs: 1000 }
    });

    const [a, b] = await Promise.all([
      derivatives.read({ identity: IDENTITY }),
      derivatives.read({ identity: IDENTITY })
    ]);
    expect([a.status, b.status]).toEqual(["ready", "ready"]);
    expect(conversions).toBe(1);
    expect(objects.get(CACHE_KEY)?.bytes).toEqual(Uint8Array.from([9, 9]));
    // 再读一次命中缓存，不再转换。
    const again = await derivatives.read({ identity: IDENTITY });
    expect(again.status).toBe("ready");
    expect(conversions).toBe(1);
    expect(derivatives.stats().hits).toBeGreaterThanOrEqual(1);
  });

  it("缓存命中仍按当前作用域验证原资产授权", async () => {
    const cacheKey = mediaDerivativeCacheKey(IDENTITY)!;
    const objects = sourceObjects();
    objects.set(cacheKey, { bytes: Uint8Array.from([7]), contentType: "image/webp" });
    const { storage } = memoryStorage(objects, {
      deny: (key, scope) => scope?.canvasId === "other-canvas" && key === SOURCE_KEY
    });
    const derivatives = createMediaDerivatives({
      storage,
      generator: async () => ({ bytes: Uint8Array.from([7]), contentType: "image/webp", width: 1, height: 1 })
    });
    // 有缓存但当前作用域读不到原资产：必须拒绝，不能返回本机缓存字节。
    await expect(
      derivatives.read({ identity: IDENTITY, scope: { canvasId: "other-canvas" } })
    ).rejects.toMatchObject({ code: "source-unavailable", status: 404 });
    // 无作用域时可以读原资产，因此缓存可用。
    const ok = await derivatives.read({ identity: IDENTITY });
    expect(ok).toEqual({ status: "ready", bytes: Uint8Array.from([7]), contentType: "image/webp" });
  });

  it("冷请求按并发预算排队，同 key 合并后不同 key 依次执行", async () => {
    const objects = sourceObjects();
    for (const edge of [128, 512] as const) {
      const key = `sha256-${String(edge).padStart(64, "0")}`;
      objects.set(key, { bytes: SOURCE_BYTES, contentType: "image/png" });
    }
    const { storage } = memoryStorage(objects);
    let running = 0;
    let peak = 0;
    const derivatives = createMediaDerivatives({
      storage,
      generator: async (input: MediaDerivativeGenerateInput) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise(resolve => setTimeout(resolve, 5));
        running--;
        return {
          bytes: Uint8Array.from([input.edge & 0xff]),
          contentType: "image/webp",
          width: input.edge,
          height: 1
        };
      },
      limits: { concurrency: 2, waitMs: 2000 }
    });
    await Promise.all([
      derivatives.read({ identity: IDENTITY }),
      derivatives.read({ identity: { ...IDENTITY, edge: 128 } }),
      derivatives.read({ identity: { ...IDENTITY, edge: 512 } })
    ]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(derivatives.stats().generated).toBe(3);
  });

  it("身份/档位/格式非法与输入超限在访问存储之前拒绝", async () => {
    const { storage, calls } = memoryStorage(sourceObjects());
    const derivatives = createMediaDerivatives({
      storage,
      generator: async () => ({ bytes: Uint8Array.from([1]), contentType: "image/webp", width: 1, height: 1 }),
      limits: { maxInputBytes: 4 }
    });
    await expect(
      derivatives.read({ identity: { ...IDENTITY, sourceKey: "generation-outputs/x.png" } })
    ).rejects.toMatchObject({ code: "malformed-request" });
    await expect(
      derivatives.read({ identity: { ...IDENTITY, edge: 999 as never } })
    ).rejects.toMatchObject({ code: "malformed-request" });
    expect(calls.stat).toHaveLength(0);
    // 输入字节超限：以 payload-too-large 结束，不启动转换。
    await expect(derivatives.read({ identity: IDENTITY })).rejects.toMatchObject({ code: "payload-too-large" });
  });

  it("转换失败不写缓存，显式重试可成功", async () => {
    const { storage, objects, calls } = memoryStorage(sourceObjects());
    let fail = true;
    const derivatives = createMediaDerivatives({
      storage,
      generator: async () => {
        if (fail) throw new Error("codec exploded");
        return { bytes: Uint8Array.from([3, 3]), contentType: "image/webp", width: 10, height: 10 };
      }
    });
    await expect(derivatives.read({ identity: IDENTITY })).rejects.toThrow(/codec/);
    expect(objects.has(CACHE_KEY)).toBe(false);
    fail = false;
    const ok = await derivatives.read({ identity: IDENTITY });
    expect(ok.status).toBe("ready");
    expect(calls.put.map(call => call.key)).toContain(CACHE_KEY);
    expect(derivatives.stats().failed).toBeGreaterThanOrEqual(1);
  });

  it("输出超过档位/像素预算视为生成失败，不写入假结果", async () => {
    const { storage, objects } = memoryStorage(sourceObjects());
    const derivatives = createMediaDerivatives({
      storage,
      generator: async () => ({ bytes: Uint8Array.from([1]), contentType: "image/webp", width: 512, height: 512 }),
      limits: { maxOutputPixels: 1024 }
    });
    await expect(derivatives.read({ identity: IDENTITY })).rejects.toMatchObject({ code: "generation-failed" });
    expect(objects.has(CACHE_KEY)).toBe(false);
  });

  it("超出缓存预算时淘汰最久未使用项；存储不支持删除则失败而不是假淘汰", async () => {
    const objects = sourceObjects();
    const second = `sha256-${"c".repeat(64)}`;
    objects.set(second, { bytes: SOURCE_BYTES, contentType: "image/png" });
    const first = memoryStorage(objects);
    let now = 1;
    const derivatives = createMediaDerivatives({
      storage: first.storage,
      generator: async () => ({
        bytes: new Uint8Array(8),
        contentType: "image/webp",
        width: 1,
        height: 1
      }),
      limits: { cacheBytesPerScope: 8, waitMs: 1000 },
      now: () => now++
    });
    expect((await derivatives.read({ identity: IDENTITY })).status).toBe("ready");
    now += 10;
    const other = await derivatives.read({ identity: { ...IDENTITY, sourceKey: second } });
    expect(other.status).toBe("ready");
    expect(first.calls.delete.map(call => call.key)).toContain(CACHE_KEY);
    expect(derivatives.stats().evicted).toBe(1);

    const noDelete = memoryStorage(objects, { deletable: false });
    const strict = createMediaDerivatives({
      storage: noDelete.storage,
      generator: async () => ({ bytes: new Uint8Array(16), contentType: "image/webp", width: 1, height: 1 }),
      limits: { cacheBytesPerScope: 8, waitMs: 1000 }
    });
    await expect(strict.read({ identity: IDENTITY })).rejects.toBeInstanceOf(MediaDerivativeError);
  });

  it("等待超时以 pending 结束且任务继续，随后重试命中已生成结果", async () => {
    const { storage, objects } = memoryStorage(sourceObjects());
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const derivatives = createMediaDerivatives({
      storage,
      generator: async () => {
        await gate;
        return { bytes: Uint8Array.from([5, 5]), contentType: "image/webp", width: 32, height: 32 };
      }
    });
    const first = await derivatives.read({ identity: IDENTITY, waitMs: 5 });
    expect(first.status).toBe("pending");
    release();
    await derivatives.drain();
    expect(objects.has(CACHE_KEY)).toBe(true);
    const second = await derivatives.read({ identity: IDENTITY, waitMs: 100 });
    expect(second.status).toBe("ready");
  });

  it("public 路由：非法派生参数在访问存储前拒绝，未启用时回退明确失败", async () => {
    const { storage, calls } = memoryStorage(sourceObjects());
    const handler = createMediaRequestHandler({ storage });
    const invalid = await invoke(handler, `/api/media/${SOURCE_KEY}?variant=thumbnail&edge=99`);
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("invalid-derivative");
    expect(calls.get).toHaveLength(0);

    const unsupported = await invoke(handler, `/api/media/${SOURCE_KEY}?variant=thumbnail&edge=256`);
    expect(unsupported.status).toBe(415);
    expect(unsupported.body.error).toBe("derivative-unsupported");
  });

  it("public 路由：未命中返回 202 pending，生成后返回受控派生物字节", async () => {
    const { storage, objects } = memoryStorage(sourceObjects());
    const derivatives = createMediaDerivatives({
      storage,
      generator: async () => ({ bytes: Uint8Array.from([4, 4, 4]), contentType: "image/webp", width: 64, height: 32 })
    });
    const handler = createMediaRequestHandler({ storage, derivatives });
    const first = await invoke(handler, `/api/media/${SOURCE_KEY}?variant=thumbnail&edge=256&format=webp`);
    expect([200, 202]).toContain(first.status);
    await derivatives.drain();
    const second = await invoke(handler, `/api/media/${SOURCE_KEY}?variant=thumbnail&edge=256&format=webp`);
    expect(second.status).toBe(200);
    expect(second.contentType).toBe("image/webp");
    expect(objects.get(CACHE_KEY)?.bytes).toEqual(Uint8Array.from([4, 4, 4]));
  });
});

/** 最小 HTTP 调用：直接构造 req/res，避免起真实端口。 */
async function invoke(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
  url: string
): Promise<{ status: number; body: Record<string, unknown>; contentType?: string }> {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = "GET";
  req.url = url;
  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];
  const body = new Promise<Buffer>(resolve => {
    res.end = ((chunk?: Buffer | string | (() => void)) => {
      if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      resolve(Buffer.concat(chunks));
      return res;
    }) as typeof res.end;
  });
  await handler(req, res);
  const bytes = await body;
  const text = bytes.toString("utf8");
  return {
    status: res.statusCode,
    body: text && text.trimStart().startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : {},
    contentType: res.getHeader("Content-Type") as string | undefined
  };
}
