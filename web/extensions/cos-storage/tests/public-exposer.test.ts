/**
 * 公开临时桶（cos-public）测试。
 *
 * 锁住四件事：桶信息来自「运行期配置 → 构建期注入」（仓库里没有任何具体桶）、凭据可独立
 * 配置或复用私有桶、地址与后端键布局完全一致、以及 exposer 声明「先复制再给地址」且默认启用。
 *
 * 夹具用不可达的假桶名，**不**引用任何真实桶：真实桶由构建环境注入。
 */
import { describe, expect, it } from "vitest";
import {
  COS_PUBLIC_BACKEND_ID,
  COS_PUBLIC_EXPOSER_ID,
  createCosPublicExposer,
  publicBucketDefaults,
  publicObjectKey,
  publicObjectUrl,
  resolveCosPublicConfig,
  type CosPublicConfig
} from "../src/public-exposer.js";

const FIXTURE_DEFAULTS = {
  bucketName: "fixture-bucket-1234567890",
  bucketUrl: "https://fixture-bucket-1234567890.cos.ap-guangzhou.myqcloud.com",
  prefix: "fixture-prefix"
};

const CONFIG: CosPublicConfig = {
  secretId: "i",
  secretKey: "k",
  bucketName: FIXTURE_DEFAULTS.bucketName,
  bucketUrl: FIXTURE_DEFAULTS.bucketUrl,
  region: "ap-guangzhou",
  prefix: FIXTURE_DEFAULTS.prefix,
  credentialSource: "public"
};

describe("构建期注入", () => {
  it("测试环境未注入时为空：仓库里不带任何具体桶", () => {
    expect(publicBucketDefaults()).toEqual({});
  });
});

describe("配置解析", () => {
  it("运行期配置优先，region 从域名解析", () => {
    const resolved = resolveCosPublicConfig({ secretId: "id", secretKey: "key", ...FIXTURE_DEFAULTS });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config).toMatchObject({
      bucketName: FIXTURE_DEFAULTS.bucketName,
      region: "ap-guangzhou",
      prefix: FIXTURE_DEFAULTS.prefix,
      credentialSource: "public"
    });
  });

  it("运行期缺省时用构建期注入值", () => {
    const resolved = resolveCosPublicConfig({
      secretId: "id",
      secretKey: "key",
      defaults: FIXTURE_DEFAULTS
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.bucketName).toBe(FIXTURE_DEFAULTS.bucketName);
  });

  it("既没配也没注入时把桶三项列为缺项，不猜", () => {
    const resolved = resolveCosPublicConfig({ secretId: "i", secretKey: "k" });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.missing).toEqual(["publicBucketName", "publicBucketUrl", "publicPrefix"]);
  });

  it("公开桶未配凭据时复用私有桶凭据，并标注来源", () => {
    const resolved = resolveCosPublicConfig({
      ...FIXTURE_DEFAULTS,
      fallbackSecretId: "shared-id",
      fallbackSecretKey: "shared-key"
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.secretId).toBe("shared-id");
    expect(resolved.config.credentialSource).toBe("shared");
  });

  it("两处都没有凭据时返回缺项，不抛错", () => {
    const resolved = resolveCosPublicConfig(FIXTURE_DEFAULTS);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.missing).toEqual(["publicSecretId", "publicSecretKey"]);
  });

  it("前缀两端的斜杠被归一化", () => {
    const resolved = resolveCosPublicConfig({ secretId: "i", secretKey: "k", ...FIXTURE_DEFAULTS, prefix: "/p/" });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.config.prefix).toBe("p");
  });
});

describe("地址与键布局", () => {
  it("URL = 域名 + 前缀 + namespace + key，与后端的键完全一致", () => {
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
  it("声明先复制到公开桶再给地址、默认启用，且不签名", () => {
    const exposer = createCosPublicExposer(CONFIG);
    expect(exposer.exposerId).toBe(COS_PUBLIC_EXPOSER_ID);
    expect(exposer.requiresReplica).toBe(true);
    expect(exposer.targetBackendId).toBe(COS_PUBLIC_BACKEND_ID);
    expect(exposer.default).toBe(true);
  });

  it("expose 返回公开地址，忽略有效期（公开桶没有签名过期）", async () => {
    const exposer = createCosPublicExposer(CONFIG);
    expect(await exposer.expose({ namespace: "media", key: "a.png", expiresSeconds: 60 })).toBe(
      FIXTURE_DEFAULTS.bucketUrl + "/fixture-prefix/media/a.png"
    );
  });
});
