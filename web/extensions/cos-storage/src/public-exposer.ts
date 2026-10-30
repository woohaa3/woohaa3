/**
 * 内置「公开临时桶」：把字节复制进一个公开读的对象存储桶，并直接给出对象 URL。
 *
 * 为什么要有它：很多第三方生成 API 只接受可被它自己拉取的 http(s) 地址，而私有桶只能
 * 签出**有时效**的地址。公开桶给的是稳定 URL，代价是「谁拿到链接都能读」——所以它只用于
 * 临时素材，桶内内容由运维侧定期清理。
 *
 * **桶信息不进公开仓库**：桶名、域名、前缀都由构建期注入（见 `__WOOHAA3_PUBLIC_BUCKET__`），
 * 构建环境用 `WOOHAA3_DEFINES` 提供；未注入时三者都必填在运行期配置里，否则不注册。
 * 凭据永远只来自运行期（设置页或环境变量），绝不参与构建。
 */
import type { StorageBackend, StorageExposer } from "@woohaa3/contracts";

/** 后端 id：与私有桶并列。 */
export const COS_PUBLIC_BACKEND_ID = "cos-public";
/** 地址提供者 id：设置 `exposer.primary=cos-public` 或在画布记录里写 exposure 即可启用。 */
export const COS_PUBLIC_EXPOSER_ID = "cos-public";
export const COS_PUBLIC_LABEL = "COS 公开临时桶";

/**
 * 构建期注入的桶信息（构建脚本用 esbuild `define` 替换）。
 *
 * 公开仓库里它恒为 `undefined`：没有注入时所有值都必须来自运行期配置。构建脚本注入的是
 * 公开桶的地址（本身可公开读），**不会**也不该注入任何凭据。
 */
declare const __WOOHAA3_PUBLIC_BUCKET__:
  | { bucketName?: string; bucketUrl?: string; prefix?: string }
  | undefined;

export type PublicBucketDefaults = {
  bucketName?: string;
  bucketUrl?: string;
  prefix?: string;
};

/** 读构建期注入值；未注入（或注入格式不对）时返回空对象，不抛错。 */
export function publicBucketDefaults(): PublicBucketDefaults {
  if (typeof __WOOHAA3_PUBLIC_BUCKET__ !== "object" || __WOOHAA3_PUBLIC_BUCKET__ === null) return {};
  const value = __WOOHAA3_PUBLIC_BUCKET__;
  return {
    ...(typeof value.bucketName === "string" ? { bucketName: value.bucketName } : {}),
    ...(typeof value.bucketUrl === "string" ? { bucketUrl: value.bucketUrl } : {}),
    ...(typeof value.prefix === "string" ? { prefix: value.prefix } : {})
  };
}

export type CosPublicConfig = {
  secretId: string;
  secretKey: string;
  bucketName: string;
  bucketUrl: string;
  region: string;
  prefix: string;
  /** 凭据来源：诊断用，不影响行为。 */
  credentialSource: "public" | "shared";
};

export type CosPublicResolution =
  | { readonly ok: true; readonly config: CosPublicConfig }
  | { readonly ok: false; readonly missing: readonly string[] };

/** 去掉两端斜杠；键与 URL 拼接共用同一份归一化。 */
function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

/** 后端键布局：core 传进来的 key 已带 namespace，这里只加桶内前缀。 */
export function publicObjectKey(config: Pick<CosPublicConfig, "prefix">, key: string): string {
  const prefix = normalizePrefix(config.prefix);
  return prefix ? prefix + "/" + key : key;
}

/**
 * 公开 URL：公开桶不需要签名，所以地址就是域名 + 键。
 *
 * 用 `encodeURI` 而不是整段编码：斜杠必须保留为路径分隔，否则对象会被当成一个含 %2F 的键。
 */
export function publicObjectUrl(
  config: Pick<CosPublicConfig, "bucketUrl" | "prefix">,
  namespace: string,
  key: string
): string {
  return config.bucketUrl.replace(/\/+$/, "") + "/" + encodeURI(publicObjectKey(config, namespace + "/" + key));
}

export type CosPublicConfigInput = {
  secretId?: string;
  secretKey?: string;
  bucketName?: string;
  bucketUrl?: string;
  prefix?: string;
  /** 私有桶凭据：公开桶未单独配置时回落用它们。 */
  fallbackSecretId?: string;
  fallbackSecretKey?: string;
  /** 构建期注入值；缺省读模块级注入。 */
  defaults?: PublicBucketDefaults;
};

/**
 * 解析公开桶配置。
 *
 * 桶名 / 域名 / 前缀按「运行期配置 → 构建期注入」取值，两者都没有时列为缺项——公开仓库
 * 不带任何默认桶，所以未注入的构建必须由使用者填全。
 */
export function resolveCosPublicConfig(input: CosPublicConfigInput): CosPublicResolution {
  const ownSecretId = (input.secretId ?? "").trim();
  const ownSecretKey = (input.secretKey ?? "").trim();
  const shared = ownSecretId === "" || ownSecretKey === "";
  const secretId = ownSecretId || (input.fallbackSecretId ?? "").trim();
  const secretKey = ownSecretKey || (input.fallbackSecretKey ?? "").trim();

  const defaults = input.defaults ?? publicBucketDefaults();
  const bucketName = (input.bucketName ?? "").trim() || (defaults.bucketName ?? "").trim();
  const bucketUrl = ((input.bucketUrl ?? "").trim() || (defaults.bucketUrl ?? "").trim()).replace(/\/+$/, "");
  const prefix = normalizePrefix((input.prefix ?? "").trim() || (defaults.prefix ?? "").trim());

  const missing: string[] = [];
  if (!secretId) missing.push("publicSecretId");
  if (!secretKey) missing.push("publicSecretKey");
  if (!bucketName) missing.push("publicBucketName");
  if (!bucketUrl) missing.push("publicBucketUrl");
  if (!prefix) missing.push("publicPrefix");
  if (missing.length > 0) return { ok: false, missing };

  return {
    ok: true,
    config: {
      secretId,
      secretKey,
      bucketName,
      bucketUrl,
      region: resolvePublicRegion(bucketUrl),
      prefix,
      credentialSource: shared ? "shared" : "public"
    }
  };
}

/** 与私有桶同一套 region 解析规则（`cos.<region>` 原值、`cos-<region>` 补 `ap-`）。 */
export function resolvePublicRegion(bucketUrl: string): string {
  const hostname = new URL(bucketUrl).hostname;
  const match = /^[^.]+\.cos\.([a-z0-9-]+)\.myqcloud\.com$/i.exec(hostname)
    ?? /^[^.]+\.cos-([a-z0-9-]+)\.myqcloud\.com$/i.exec(hostname);
  if (!match?.[1]) throw new Error("Invalid COS public bucket URL: " + bucketUrl);
  return hostname.includes(".cos-") ? "ap-" + match[1] : match[1];
}

/**
 * 公开桶的地址提供者。
 *
 * `requiresReplica: true` + `targetBackendId`：公开桶里的对象必须先存在才能给出 URL，
 * 所以 core 在调用 `expose` 之前会把字节复制过去（内容寻址，幂等）。
 *
 * `default: true`：开关打开即生效，不要求用户再去填 `exposer.primary`。
 */
export function createCosPublicExposer(config: CosPublicConfig): StorageExposer {
  return {
    exposerId: COS_PUBLIC_EXPOSER_ID,
    label: COS_PUBLIC_LABEL,
    requiresReplica: true,
    targetBackendId: COS_PUBLIC_BACKEND_ID,
    default: true,
    async expose(input) {
      return publicObjectUrl(config, input.namespace, input.key);
    }
  };
}

/**
 * 便于测试断言：公开桶后端应当采用与 URL 完全一致的键布局。
 */
export function publicKeyForBackend(config: CosPublicConfig, key: string): string {
  return publicObjectKey(config, key);
}

export type { StorageBackend };
