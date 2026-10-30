/**
 * 本地存储的「公开临时桶」：把字节推到公开只读的对象存储桶，并给出可直接拉取的地址。
 *
 * 为什么它挂在 local 而不是 cos：很多第三方生成 API 只接受**它自己**能拉取的 http(s)
 * 地址，而「完全本地」的部署恰恰没有公网身份。这个能力不是「字节存在哪」的选择，而是
 * 「本地字节怎么临时对外」的补丁，所以它跟着 local 走：配置段是 `storage.local.*`，
 * 默认值也在 local 里，开着它就能让纯本地部署出公网地址。
 *
 * 三条边界：
 * - 地址不签名：谁拿到链接都能读，所以只用于临时素材，桶内内容由运维侧定期清理；
 * - 字节搬家由**提供者自己**完成（`requiresReplica: false`）：core 不复制，这里从
 *   `ctx.storage` 读出来再 PUT 到公开桶，键与 URL 用同一份布局；
 * - 它**不是**兜底：`exposer.primary` 未选时不会自动生效，必须显式选择，避免悄悄把
 *   用户素材推到公网。
 *
 * **桶信息不进公开仓库**：桶名、域名、前缀都由构建期注入（见 `@@WOOHAA3_PUBLIC_BUCKET@@`），
 * 构建环境用 `WOOHAA3_DEFINES` 提供；未注入时三者必须由运行期配置补齐，否则不注册。
 * 凭据永远只来自运行期（配置文件或环境变量），绝不参与构建。
 */
import COS from "cos-nodejs-sdk-v5";
import type { HostStorageService, StorageExposer } from "@woohaa3/contracts";

/** 地址提供者 id：`exposer.primary=local-public` 或画布 exposure 覆盖才会启用。 */
export const LOCAL_PUBLIC_EXPOSER_ID = "local-public";
/** 设置页与日志里的显示名。 */
export const LOCAL_PUBLIC_LABEL = "公开临时桶";

/**
 * 构建期注入的桶信息（构建脚本用 esbuild `define` 替换）。
 *
 * 公开仓库里它恒为 `undefined`：没有注入时所有值都必须来自运行期配置。注入的是公开桶的
 * 地址（本身可公开读），**不会**也不该注入任何凭据。
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

export type PublicBucketConfig = {
  secretId: string;
  secretKey: string;
  bucketName: string;
  bucketUrl: string;
  region: string;
  prefix: string;
  /** 凭据来源：诊断用，不影响行为。 */
  credentialSource: "own" | "shared";
};

export type PublicBucketResolution =
  | { readonly ok: true; readonly config: PublicBucketConfig }
  | { readonly ok: false; readonly missing: readonly string[] };

export type PublicBucketInput = {
  secretId?: string;
  secretKey?: string;
  /** 共享凭据（来自 `storage.cos` 配置段）：公开桶没单独配时复用它。 */
  sharedSecretId?: string;
  sharedSecretKey?: string;
  bucketName?: string;
  bucketUrl?: string;
  prefix?: string;
  /**
   * 环境变量：公开桶字段留空时按「专用变量 → 私有桶变量」取值。
   *
   * 复用私有桶凭据是常态（同一操作者的两个桶），但**不同桶可以各配一份**：先看
   * `COS_PUBLIC_SECRET_ID`，再退到 `COS_SECRET_ID`。
   */
  env?: Record<string, string | undefined>;
  /** 构建期注入值；缺省读模块级注入。 */
  defaults?: PublicBucketDefaults;
};

/** 去掉两端斜杠；键与 URL 拼接共用同一份归一化。 */
function normalizePrefix(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

/** 与私有桶同一套 region 解析规则（`cos.<region>` 原值、`cos-<region>` 补 `ap-`）。 */
function resolveRegion(bucketUrl: string): string {
  const hostname = new URL(bucketUrl).hostname;
  const match = /^[^.]+\.cos\.([a-z0-9-]+)\.myqcloud\.com$/i.exec(hostname)
    ?? /^[^.]+\.cos-([a-z0-9-]+)\.myqcloud\.com$/i.exec(hostname);
  if (!match?.[1]) throw new Error("Invalid COS public bucket URL: " + bucketUrl);
  return hostname.includes(".cos-") ? "ap-" + match[1] : match[1];
}

/**
 * 解析公开桶配置。
 *
 * 桶名 / 域名 / 前缀：运行期配置 → 构建期注入；两者都没有时列为缺项——公开仓库不带任何
 * 默认桶，未注入的构建必须由使用者填全。凭据：配置 → `COS_PUBLIC_*` → `COS_SECRET_*`。
 */
export function resolvePublicBucketConfig(input: PublicBucketInput): PublicBucketResolution {
  const env = input.env ?? {};
  const envValue = (...names: string[]): string => {
    for (const name of names) {
      const value = env[name]?.trim();
      if (value) return value;
    }
    return "";
  };

  // 凭据分两级：公开桶自己的（配置或 COS_PUBLIC_*），以及私有桶那对（storage.cos 配置、
  // COS_SECRET_*）。两级成对取，不把 A 的 id 和 B 的 key 拼在一起——那种组合永远签不出来。
  const dedicatedId = (input.secretId ?? "").trim() || envValue("COS_PUBLIC_SECRET_ID");
  const dedicatedKey = (input.secretKey ?? "").trim() || envValue("COS_PUBLIC_SECRET_KEY");
  const dedicated = dedicatedId !== "" && dedicatedKey !== "";
  const sharedId = (input.sharedSecretId ?? "").trim() || envValue("COS_SECRET_ID");
  const sharedKey = (input.sharedSecretKey ?? "").trim() || envValue("COS_SECRET_KEY");
  const secretId = dedicated ? dedicatedId : sharedId;
  const secretKey = dedicated ? dedicatedKey : sharedKey;

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
      region: resolveRegion(bucketUrl),
      prefix,
      credentialSource: dedicated ? "own" : "shared"
    }
  };
}

/** 桶内键布局：core 传进来的 key 已带 namespace，这里只加桶内前缀。 */
export function publicObjectKey(config: Pick<PublicBucketConfig, "prefix">, key: string): string {
  const prefix = normalizePrefix(config.prefix);
  return prefix ? prefix + "/" + key : key;
}

/**
 * 公开 URL：公开桶不需要签名，所以地址就是域名 + 键。
 *
 * 用 `encodeURI` 而不是整段编码：斜杠必须保留为路径分隔，否则对象会被当成一个含 %2F 的键。
 */
export function publicObjectUrl(
  config: Pick<PublicBucketConfig, "bucketUrl" | "prefix">,
  namespace: string,
  key: string
): string {
  return config.bucketUrl.replace(/\/+$/, "") + "/" + encodeURI(publicObjectKey(config, namespace + "/" + key));
}

/**
 * 公开桶的最小写入面。
 *
 * 抽成接口是为了测试不碰真 SDK；生产实现见 {@link createCosPublicBucketWriter}。
 */
export type PublicBucketWriter = {
  /** 桶内已有对象的字节数；不存在返回 null（用于「同尺寸就跳过」的幂等判断）。 */
  stat(objectKey: string): Promise<number | null>;
  put(objectKey: string, bytes: Uint8Array, contentType: string): Promise<void>;
};

type CosError = { statusCode?: number; code?: string };
/** SDK 的回调签名在各方法间不一致，这里只关心「有没有 error」，故按 unknown 收。 */
type CosCallback<T> = (error: unknown, data: T) => void;

/** COS 实现：只用 headObject / putObject，地址由本模块自己拼，不用 SDK 的签名地址。 */
export function createCosPublicBucketWriter(config: PublicBucketConfig): PublicBucketWriter {
  const cos = new COS({ SecretId: config.secretId, SecretKey: config.secretKey });
  const base = () => ({ Bucket: config.bucketName, Region: config.region });
  return {
    async stat(objectKey) {
      try {
        const data = await invoke<{ headers?: Record<string, string> }>((callback) =>
          cos.headObject({ ...base(), Key: objectKey }, callback)
        );
        const headers = data.headers ?? {};
        const size = Number(headers["content-length"] ?? headers["Content-Length"]);
        return Number.isFinite(size) && size >= 0 ? size : null;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async put(objectKey, bytes, contentType) {
      // cos-nodejs-sdk-v5 接受 Buffer/Stream/String，不接受 Uint8Array。
      await invoke((callback) =>
        cos.putObject({ ...base(), Key: objectKey, Body: Buffer.from(bytes), ContentType: contentType }, callback)
      );
    }
  };
}

/**
 * 公开临时桶的地址提供者。
 *
 * `requiresReplica: false`：字节由本提供者推送（读 `ctx.storage` → PUT 公开桶），core 不复制，
 * 这样公开桶不必注册成存储后端，也就不会出现在「主存储」下拉里——它不是一种字节驻留选择。
 * 对象已存在且尺寸一致时跳过上传（键内容寻址，重复调用幂等）。
 */
export function createPublicBucketExposer(options: {
  /** 固定配置（测试/调用方已解析好）。 */
  config?: PublicBucketConfig;
  writer?: PublicBucketWriter;
  /** 按需解析：允许启动后再读凭据（例如 cos-storage 比本插件晚装载）。 */
  resolveConfig?: () => PublicBucketConfig;
  storage: HostStorageService;
}): StorageExposer {
  const { storage } = options;
  const current = (): { config: PublicBucketConfig; writer: PublicBucketWriter } => {
    if (options.config && options.writer) return { config: options.config, writer: options.writer };
    if (!options.resolveConfig) throw new Error("公开临时桶缺少配置解析器");
    const config = options.resolveConfig();
    return { config, writer: createCosPublicBucketWriter(config) };
  };
  return {
    exposerId: LOCAL_PUBLIC_EXPOSER_ID,
    label: LOCAL_PUBLIC_LABEL,
    requiresReplica: false,
    async expose(input) {
      // 每次现解析：热重载/共享凭据在启动后补齐时都不需要重启插件。
      const { config, writer } = current();
      const objectKey = publicObjectKey(config, input.namespace + "/" + input.key);
      const object = await storage.bucket(input.namespace, input.scope).get(input.key);
      if ((await writer.stat(objectKey)) !== object.bytes.byteLength) {
        await writer.put(objectKey, object.bytes, object.contentType ?? "application/octet-stream");
      }
      return publicObjectUrl(config, input.namespace, input.key);
    }
  };
}

function invoke<T>(run: (callback: CosCallback<T>) => void): Promise<T> {
  return new Promise((resolve, reject) => run((error, data) => (error ? reject(error) : resolve(data))));
}

function isNotFound(error: unknown): boolean {
  const value = error as CosError | null | undefined;
  return Boolean(value && (value.statusCode === 404 || value.code === "NoSuchKey" || value.code === "NotFound"));
}
