/**
 * 公开临时桶（local-public）测试。
 *
 * 锁住五件事：桶信息来自「运行期配置 → 构建期注入」（仓库里没有任何具体桶）、凭据按
 * 「配置 → COS_PUBLIC_* → COS_SECRET_*」回落、地址与桶内键布局完全一致、提供者自己推字节
 * 且不声明默认（推素材上公网必须显式选择）。
 *
 * 夹具用不可达的假桶名，**不**引用任何真实桶：真实桶由构建环境注入。
 */
import { describe, expect, it } from "vitest";
import type { HostStorageService } from "@woohaa3/contracts";
import {
  LOCAL_PUBLIC_EXPOSER_ID,
  createPublicBucketExposer,
  publicBucketDefaults,
  publicObjectKey,
  publicObjectUrl,
  resolvePublicBucketConfig,
  type PublicBucketConfig,
  type PublicBucketWriter
} from "../src/public-bucket.js";

const FIXTURE_DEFAULTS = {
  bucketName: "fixture-bucket-1234567890",
  bucketUrl: "https://fixture-bucket-1234567890.cos.ap-guangzhou.myqcloud.com",
  prefix: "fixture-prefix"
};

const CONFIG: PublicBucketConfig = {
  secretId: "i",
  secretKey: "k",
  bucketName: FIXTURE_DEFAULTS.bucketName,
  bucketUrl: FIXTURE_DEFAULTS.bucketUrl,
  region: "ap-guangzhou",
  prefix: FIXTURE_DEFAULTS.prefix,
  credentialSource: "own"
};

describe("构建期注入", () => {
  it("测试环境未注入时为空：仓库里不带任何具体桶", () => {
    expect(publicBucketDefaults()).toEqual({});
  });
});

describe("配置解析", () => {
  it("运行期配置优先，region 从域名解析", () => {
    const resolved = resolvePublicBucketConfig({ secretId: "id", secretKey: "key", ...FIXTURE_DEFAULTS, env: {} });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config).toMatchObject({
      bucketName: FIXTURE_DEFAULTS.bucketName,
      region: "ap-guangzhou",
      prefix: FIXTURE_DEFAULTS.prefix,
      credentialSource: "own"
    });
  });

  it("运行期缺省时用构建期注入值", () => {
    const resolved = resolvePublicBucketConfig({ secretId: "id", secretKey: "key", defaults: FIXTURE_DEFAULTS, env: {} });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.bucketName).toBe(FIXTURE_DEFAULTS.bucketName);
  });

  it("既没配也没注入时把桶三项列为缺项，不猜", () => {
    const resolved = resolvePublicBucketConfig({ secretId: "i", secretKey: "k", env: {} });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.missing).toEqual(["publicBucketName", "publicBucketUrl", "publicPrefix"]);
  });

  it("凭据先用专用的 COS_PUBLIC_*，没有再回落到私有桶的 COS_*", () => {
    const own = resolvePublicBucketConfig({
      ...FIXTURE_DEFAULTS,
      env: { COS_PUBLIC_SECRET_ID: "p-id", COS_PUBLIC_SECRET_KEY: "p-key", COS_SECRET_ID: "s-id", COS_SECRET_KEY: "s-key" }
    });
    expect(own.ok && own.config.secretId).toBe("p-id");
    expect(own.ok && own.config.credentialSource).toBe("own");

    const shared = resolvePublicBucketConfig({ ...FIXTURE_DEFAULTS, env: { COS_SECRET_ID: "s-id", COS_SECRET_KEY: "s-key" } });
    expect(shared.ok && shared.config.secretId).toBe("s-id");
    expect(shared.ok && shared.config.credentialSource).toBe("shared");
  });

  it("storage.cos 的共享凭据可显式传入，标为 shared", () => {
    const resolved = resolvePublicBucketConfig({
      ...FIXTURE_DEFAULTS,
      sharedSecretId: "s-id",
      sharedSecretKey: "s-key",
      env: {}
    });
    expect(resolved.ok && resolved.config.secretId).toBe("s-id");
    expect(resolved.ok && resolved.config.credentialSource).toBe("shared");
  });

  it("配置里给了凭据时不看环境变量，并标注来源为 own", () => {
    const resolved = resolvePublicBucketConfig({
      secretId: "id",
      secretKey: "key",
      ...FIXTURE_DEFAULTS,
      env: { COS_SECRET_ID: "s-id", COS_SECRET_KEY: "s-key" }
    });
    expect(resolved.ok && resolved.config.secretId).toBe("id");
    expect(resolved.ok && resolved.config.credentialSource).toBe("own");
  });

  it("两处都没有凭据时返回缺项，不抛错", () => {
    const resolved = resolvePublicBucketConfig({ ...FIXTURE_DEFAULTS, env: {} });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.missing).toEqual(["publicSecretId", "publicSecretKey"]);
  });

  it("前缀两端的斜杠被归一化", () => {
    const resolved = resolvePublicBucketConfig({ secretId: "i", secretKey: "k", ...FIXTURE_DEFAULTS, prefix: "/p/", env: {} });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.prefix).toBe("p");
  });
});

describe("地址与键布局", () => {
  it("URL = 域名 + 前缀 + namespace + key，与推上去的键完全一致", () => {
    expect(publicObjectKey(CONFIG, "media/a.png")).toBe("fixture-prefix/media/a.png");
    expect(publicObjectUrl(CONFIG, "media", "a.png")).toBe(
      FIXTURE_DEFAULTS.bucketUrl + "/fixture-prefix/media/a.png"
    );
  });

  it("空前缀时不产生双斜杠", () => {
    expect(publicObjectUrl({ ...CONFIG, prefix: "" }, "media", "a.png")).toBe(
      FIXTURE_DEFAULTS.bucketUrl + "/media/a.png"
    );
  });
});

describe("地址提供者", () => {
  const storageWith = (bytes: Uint8Array, contentType?: string) =>
    ({
      bucket: () => ({
        get: async () => ({ bytes, ...(contentType ? { contentType } : {}) })
      })
    }) as unknown as HostStorageService;

  const writerWith = (existing?: number) => {
    const puts: Array<{ key: string; size: number; contentType: string }> = [];
    const writer: PublicBucketWriter = {
      async stat() {
        return existing ?? null;
      },
      async put(key, bytes, contentType) {
        puts.push({ key, size: bytes.byteLength, contentType });
      }
    };
    return { writer, puts };
  };

  it("自己推字节，不要求 core 复制，也没有默认提供者的身份", async () => {
    const exposer = createPublicBucketExposer({ config: CONFIG, writer: writerWith().writer, storage: storageWith(Uint8Array.of(1)) });
    expect(exposer.exposerId).toBe(LOCAL_PUBLIC_EXPOSER_ID);
    expect(exposer.requiresReplica).toBe(false);
    expect("default" in exposer).toBe(false);
  });

  it("推上去的键与返回的 URL 一致；缺 contentType 时用二进制兜底", async () => {
    const { writer, puts } = writerWith();
    const exposer = createPublicBucketExposer({ config: CONFIG, writer, storage: storageWith(Uint8Array.of(1, 2, 3)) });
    const url = await exposer.expose({ namespace: "media", key: "a.png", expiresSeconds: 60 });
    expect(url).toBe(FIXTURE_DEFAULTS.bucketUrl + "/fixture-prefix/media/a.png");
    expect(puts).toEqual([{ key: "fixture-prefix/media/a.png", size: 3, contentType: "application/octet-stream" }]);
  });

  it("桶里已有同尺寸对象时跳过上传（键内容寻址，重复调用幂等）", async () => {
    const { writer, puts } = writerWith(2);
    const exposer = createPublicBucketExposer({ config: CONFIG, writer, storage: storageWith(Uint8Array.of(1, 2)) });
    await exposer.expose({ namespace: "media", key: "a.png" });
    expect(puts).toEqual([]);
  });

  it("尺寸不一致时重传", async () => {
    const { writer, puts } = writerWith(1);
    const exposer = createPublicBucketExposer({ config: CONFIG, writer, storage: storageWith(Uint8Array.of(1, 2)) });
    await exposer.expose({ namespace: "media", key: "a.png" });
    expect(puts).toHaveLength(1);
  });
});
