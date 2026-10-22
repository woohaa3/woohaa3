/**
 * COS 存储后端插件测试（由 media-service 的 `cos-media-storage.test.ts` 迁移而来）。
 *
 * 用注入的假 COS 客户端覆盖 put / get / head / presign 与 not-found 映射，并锁定对象键布局
 * `${prefix}/${namespace}/${key}`（media 即 `${prefix}/media/${key}`）与 region 解析规则；
 * 插件侧覆盖「缺配置只记日志、不注册后端」。测试传的 key 带 namespace，与 core 的契约一致。
 */
import { describe, expect, it } from "vitest";
import type { PassThrough } from "node:stream";
import { StorageObjectNotFoundError, type HostExtensionContext, type StorageBackend } from "@woohaa3/contracts";
import { COS_ENV_KEYS,
  DEFAULT_SIGNED_URL_EXPIRES_SECONDS,
  createCosBackend,
  createCosStoragePlugin,
  resolveCosConfig,
  resolveCosRegion,
  type CosConfig } from "../src/backend.js";

const CONFIG: CosConfig = {
  secretId: "secret-id",
  secretKey: "secret-key",
  bucketName: "bucket-1234567890",
  bucketUrl: "https://bucket-1234567890.cos.ap-beijing.myqcloud.com",
  region: "ap-beijing",
  prefix: "seedance-assets"
};

type Call = { op: string; params: Record<string, unknown> };

function fakeCos(options: {
  objects?: Map<string, { body: Buffer; contentType?: string }>;
  failWith?: { put?: unknown; get?: unknown; head?: unknown; url?: unknown; delete?: unknown };
  url?: string;
  withDelete?: boolean;
}) {
  const objects = options.objects ?? new Map<string, { body: Buffer; contentType?: string }>();
  const calls: Call[] = [];
  const invoke = <T>(value: T | undefined, error: unknown, callback: (e: unknown, d?: T) => void) => {
    if (error) callback(error);
    else callback(null, value);
  };
  const client = {
    putObject(params: Record<string, unknown>, callback: (e: unknown) => void) {
      calls.push({ op: "put", params });
      const body = params.Body as Buffer;
      if (!options.failWith?.put) {
        objects.set(String(params.Key), {
          body,
          contentType: params.ContentType ? String(params.ContentType) : undefined
        });
      }
      invoke(undefined, options.failWith?.put, callback);
    },
    getObject(params: Record<string, unknown>, callback: (e: unknown, d?: unknown) => void) {
      calls.push({ op: "get", params });
      const record = objects.get(String(params.Key));
      if (options.failWith?.get || !record) {
        invoke(undefined, options.failWith?.get ?? { statusCode: 404 }, callback);
        return;
      }
      invoke({ Body: record.body, headers: { "content-type": record.contentType } }, undefined, callback);
    },
    headObject(params: Record<string, unknown>, callback: (e: unknown, d?: unknown) => void) {
      calls.push({ op: "head", params });
      const record = objects.get(String(params.Key));
      if (options.failWith?.head || !record) {
        invoke(undefined, options.failWith?.head ?? { code: "NoSuchKey" }, callback);
        return;
      }
      invoke(
        { headers: { "content-length": String(record.body.byteLength), "Content-Type": record.contentType } },
        undefined,
        callback
      );
    },
    getObjectUrl(params: Record<string, unknown>, callback: (e: unknown, d?: unknown) => void) {
      calls.push({ op: "url", params });
      if (options.failWith?.url) {
        invoke(undefined, options.failWith.url, callback);
        return;
      }
      invoke({ Url: options.url ?? "http://bucket.example.com/media/key?sign=abc" }, undefined, callback);
    },
    ...(options.withDelete === false
      ? {}
      : {
          deleteObject(params: Record<string, unknown>, callback: (e: unknown) => void) {
            calls.push({ op: "delete", params });
            if (!options.failWith?.delete) objects.delete(String(params.Key));
            invoke(undefined, options.failWith?.delete, callback);
          }
        })
  };
  return { client, calls, objects };
}

function fakeCtx(): {
  ctx: HostExtensionContext;
  registered: StorageBackend[];
  logs: Array<Record<string, unknown>>;
  disposers: Array<() => void>;
} {
  const registered: StorageBackend[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const disposers: Array<() => void> = [];
  const ctx = {
    storage: {
      register(backend: StorageBackend) {
        registered.push(backend);
        return () => {
          const index = registered.indexOf(backend);
          if (index >= 0) registered.splice(index, 1);
        };
      }
    },
    log: {
      scope: () => (event: Record<string, unknown>) => {
        logs.push(event);
      }
    },
    effect: (callback: () => () => void) => {
      disposers.push(callback());
    }
  } as unknown as HostExtensionContext;
  return { ctx, registered, logs, disposers };
}

describe("region 解析", () => {
  it("两种 bucket URL 形式都支持，且 cos-<region> 会补 ap- 前缀", () => {
    expect(resolveCosRegion("https://bucket-123.cos.ap-beijing.myqcloud.com")).toBe("ap-beijing");
    expect(resolveCosRegion("https://bucket-123.cos-guangzhou.myqcloud.com")).toBe("ap-guangzhou");
    expect(resolveCosRegion("https://bucket-123.cos.ap-shanghai.myqcloud.com")).toBe("ap-shanghai");
  });

  it("非法 bucket URL 抛可诊断错误", () => {
    expect(() => resolveCosRegion("https://example.com")).toThrow(/Invalid COS_BUCKET_URL/);
  });
});

describe("配置归一化（缺项不再抛错）", () => {
  it("齐备时读出配置并归一化 prefix / 末尾斜杠", () => {
    const resolved = resolveCosConfig({
      secretId: "id",
      secretKey: "key",
      bucketName: "bucket",
      bucketUrl: "https://bucket.cos.ap-beijing.myqcloud.com/",
      prefix: "/assets/"
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.prefix).toBe("assets");
    expect(resolved.config.bucketUrl).toBe("https://bucket.cos.ap-beijing.myqcloud.com");
    expect(resolved.config.region).toBe("ap-beijing");
  });

  it("缺任一必需项时返回 missing 而不是抛错", () => {
    const resolved = resolveCosConfig({ secretId: "id", prefix: "p" });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.missing).toEqual(["secretKey", "bucketName", "bucketUrl"]);
    expect(COS_ENV_KEYS).toContain("COS_PREFIX");
  });

  it("空白值不算已配置", () => {
    const resolved = resolveCosConfig({
      secretId: "   ",
      secretKey: "key",
      bucketName: "bucket",
      bucketUrl: "https://bucket.cos.ap-beijing.myqcloud.com",
      prefix: "p"
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.missing).toEqual(["secretId"]);
  });

  it("缺配置时 apply 记结构化日志且不注册后端", async () => {
    const { ctx, registered, logs } = fakeCtx();
    await createCosStoragePlugin().apply(ctx, {});

    expect(registered).toEqual([]);
    expect(logs).toEqual([
      { event: "cos-storage-unconfigured", missing: ["secretId", "secretKey", "bucketName", "bucketUrl", "prefix"] }
    ]);
  });

  it("配置齐备时 apply 经 ctx.effect 注册 backendId=cos", async () => {
    const { ctx, registered, logs, disposers } = fakeCtx();
    await createCosStoragePlugin().apply(ctx, {
      secretId: "id",
      secretKey: "key",
      bucketName: "bucket",
      bucketUrl: "https://bucket.cos.ap-beijing.myqcloud.com",
      prefix: "assets"
    });

    expect(registered.map((backend) => backend.backendId)).toEqual(["cos"]);
    expect(registered[0]?.label).toBe("COS / S3 对象存储");
    expect(logs[0]).toMatchObject({ event: "cos-storage-activated", backendId: "cos" });

    disposers.forEach((dispose) => dispose());
    expect(registered).toEqual([]);
  });
});

describe("put / get / head", () => {
  it("put 把 Uint8Array 转成 Buffer，并使用受控对象键", async () => {
    const { client, calls, objects } = fakeCos({});
    const storage = createCosBackend(CONFIG, client as never);

    await storage.put("media/shot.png", Uint8Array.of(1, 2, 3), "image/png");

    const put = calls.find((call) => call.op === "put");
    expect(put).toBeDefined();
    expect(Buffer.isBuffer(put?.params.Body)).toBe(true);
    expect(Array.from(put?.params.Body as Buffer)).toEqual([1, 2, 3]);
    expect(put?.params.ContentType).toBe("image/png");
    // 键布局是数据兼容契约：prefix + / + 带 namespace 的 key（media 即 prefix/media/key）
    expect(put?.params.Key).toBe("seedance-assets/media/shot.png");
    expect(objects.has("seedance-assets/media/shot.png")).toBe(true);
  });

  it("忽略画布作用域：对象键仍是 <prefix>/<namespace>/<key>（已存对象不失联）", async () => {
    const { client, calls } = fakeCos({});
    const storage = createCosBackend(CONFIG, client as never);
    const scope = { canvasId: "canvas-1" };

    await storage.put("media/shot.png", Uint8Array.of(1), "image/png", scope);
    expect(calls.find((call) => call.op === "put")?.params.Key).toBe("seedance-assets/media/shot.png");
    expect(await storage.head("media/shot.png", scope)).toEqual({ size: 1, contentType: "image/png" });
    expect(Array.from((await storage.get("media/shot.png", scope)).bytes)).toEqual([1]);
    await storage.presign?.("media/shot.png", { expiresSeconds: 60 }, scope);
    expect(calls.find((call) => call.op === "url")?.params.Key).toBe("seedance-assets/media/shot.png");
  });

  it("get 返回字节与 content type", async () => {
    const { client } = fakeCos({});
    const storage = createCosBackend(CONFIG, client as never);
    await storage.put("media/shot.png", Uint8Array.of(9, 8, 7), "image/png");

    const object = await storage.get("media/shot.png");
    expect(Array.from(object.bytes)).toEqual([9, 8, 7]);
    expect(object.contentType).toBe("image/png");
  });

  it("get 在 COS 404 时抛 StorageObjectNotFoundError（保留跨 bundle 的 code/name/key）", async () => {
    const { client } = fakeCos({ failWith: { get: { statusCode: 404 } } });
    const storage = createCosBackend(CONFIG, client as never);

    await expect(storage.get("media/missing.png")).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    try {
      await storage.get("media/missing.png");
    } catch (error) {
      expect((error as StorageObjectNotFoundError).code).toBe("STORAGE_OBJECT_NOT_FOUND");
      expect((error as StorageObjectNotFoundError).name).toBe("StorageObjectNotFoundError");
      expect((error as StorageObjectNotFoundError).key).toBe("media/missing.png");
    }
  });

  it("get 对非 404 错误原样抛出，不伪装成 not-found", async () => {
    const { client } = fakeCos({ failWith: { get: { statusCode: 500 } } });
    const storage = createCosBackend(CONFIG, client as never);

    await expect(storage.get("media/shot.png")).rejects.not.toBeInstanceOf(StorageObjectNotFoundError);
  });

  it("head 读取 size 与 content type；不存在返回 null；其它错误抛出", async () => {
    const { client } = fakeCos({});
    const storage = createCosBackend(CONFIG, client as never);
    await storage.put("media/shot.png", Uint8Array.of(1, 2, 3, 4), "image/png");

    expect(await storage.head("media/shot.png")).toEqual({ size: 4, contentType: "image/png" });
    expect(await storage.head("media/missing.png")).toBeNull();

    const failing = fakeCos({ failWith: { head: { statusCode: 403 } } });
    const strict = createCosBackend(CONFIG, failing.client as never);
    await expect(strict.head("media/shot.png")).rejects.toMatchObject({ statusCode: 403 });
  });

  it("head 遇到非法 content-length 时抛错而不是返回假大小", async () => {
    const client = {
      putObject() {},
      getObject() {},
      headObject(_params: unknown, callback: (e: unknown, d?: unknown) => void) {
        callback(null, { headers: { "content-length": "not-a-number" } });
      },
      getObjectUrl() {}
    };
    const storage = createCosBackend(CONFIG, client as never);
    await expect(storage.head("media/bad.png")).rejects.toThrow(/无法读取 COS 对象大小/);
  });

  it("有 deleteObject 时暴露 delete 并删除同名对象键，没有时 delete 缺省", async () => {
    const { client, calls, objects } = fakeCos({});
    const storage = createCosBackend(CONFIG, client as never);
    await storage.put("media/shot.png", Uint8Array.of(1), "image/png");

    await storage.delete?.("media/shot.png");
    expect(calls.find((call) => call.op === "delete")?.params.Key).toBe("seedance-assets/media/shot.png");
    expect(objects.has("seedance-assets/media/shot.png")).toBe(false);

    const noDelete = fakeCos({ withDelete: false });
    expect(createCosBackend(CONFIG, noDelete.client as never).delete).toBeUndefined();
  });
});

describe("presign", () => {
  it("默认 900 秒签名，并把 http 升级为 https", async () => {
    const { client, calls } = fakeCos({});
    const storage = createCosBackend(CONFIG, client as never);

    const url = await storage.presign?.("media/shot.png");

    const request = calls.find((call) => call.op === "url");
    expect(request?.params.Sign).toBe(true);
    expect(request?.params.Expires).toBe(DEFAULT_SIGNED_URL_EXPIRES_SECONDS);
    expect(DEFAULT_SIGNED_URL_EXPIRES_SECONDS).toBe(900);
    expect(request?.params.Key).toBe("seedance-assets/media/shot.png");
    expect(url?.startsWith("https://")).toBe(true);
  });

  it("可指定有效期", async () => {
    const { client, calls } = fakeCos({});
    const storage = createCosBackend(CONFIG, client as never);

    await storage.presign?.("media/shot.png", { expiresSeconds: 60 });
    expect(calls.find((call) => call.op === "url")?.params.Expires).toBe(60);
  });

  it("空 URL 抛可诊断错误", async () => {
    const { client } = fakeCos({ url: "   " });
    const storage = createCosBackend(CONFIG, client as never);
    await expect(storage.presign?.("media/shot.png")).rejects.toThrow(/无法生成 COS 访问地址/);
  });
});

it("COS 区间以流输出，首段不等待完整对象；取消会通知 SDK 终止请求", async () => {
  const fake = fakeCos({});
  let output: PassThrough | undefined;
  let received: Record<string, unknown> | undefined;
  const storage = createCosBackend(CONFIG, { ...fake.client,
    getObject(params: Record<string, unknown>) {
      received = params;
      output = params.Output as PassThrough;
      output.write(Buffer.from("ab"));
    }
  } as never);
  const stream = await storage.openRead!("media/video.mp4", { start: 10, end: 19 });
  expect(received).toMatchObject({ Bucket: CONFIG.bucketName, Region: CONFIG.region,
    Key: `${CONFIG.prefix}/media/video.mp4`, Range: "bytes=10-19" });
  const iterator = stream.bytes[Symbol.asyncIterator]();
  expect(Buffer.from((await iterator.next()).value!).toString()).toBe("ab");
  expect(output!.writableFinished).toBe(false);
  const cancelled = new Promise<unknown>(resolve => output!.once("error", resolve));
  stream.cancel();
  await expect(cancelled).resolves.toBeInstanceOf(Error);
  expect(output!.destroyed).toBe(true);
});
