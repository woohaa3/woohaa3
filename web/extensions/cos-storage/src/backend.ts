/**
 * COS / S3 对象存储后端插件（扩展层）。
 *
 * 由 media-service 内的 COS 适配迁出（原 `web/services/media-service/src/storage/cos/index.ts`）：
 * 存储后端不再住在某个使用方服务里，而是作为扩展层插件向 `ctx.storage` 注册 `backendId = "cos"`。
 * **仅服务端可用**：它使用 Node `Buffer`，且持有 COS 凭据，绝不能进入浏览器 bundle。
 *
 * 必须原样保留的字符串/行为（改了会破坏数据或运行时契约）：
 * - 对象键布局 `${prefix}/media/${key}` —— 改了会让已存对象全部失联。对 `StorageScope` 无感：
 *   画布维度只有 server 后端用，COS 的键布局与已存对象保持不变（所以这里不接 scope 参数）。
 * - 旧环境变量名 `COS_SECRET_ID` / `COS_SECRET_KEY` / `COS_BUCKET_NAME` / `COS_BUCKET_URL` /
 *   `COS_PREFIX`（经配置项 `legacyEnv` 兼容）。
 * - COS 的 not-found 映射（`statusCode === 404` / `code === "NoSuchKey"` / `code === "NotFound"`）。
 * - 签名 URL 默认 900 秒、`Sign: true`、以及 `http://` → `https://` 升级。
 * - 响应头大小写两种写法。
 * - 两种 bucket URL 形式的 region 解析规则（含 `cos-<region>` → `ap-<region>` 的不对称前缀规则）。
 */
import COS from "cos-nodejs-sdk-v5";
import { PassThrough, Readable } from "node:stream";
import {
  defineConfigSchema,
  StorageObjectNotFoundError,
  type ExtensionPlugin,
  type StorageBackend,
  type StorageObject,
  type StorageObjectStat
} from "@woohaa3/contracts";
import {
  COS_PUBLIC_BACKEND_ID,
  COS_PUBLIC_LABEL,
  createCosPublicExposer,
  resolveCosPublicConfig
} from "./public-exposer.js";

type CosError = Error & { statusCode?: number; code?: string };
type CosCallback<T> = (error: CosError | null, data: T) => void;
type CosLike = {
  putObject(params: Record<string, unknown>, callback: CosCallback<unknown>): void;
  getObject(params: Record<string, unknown>, callback: CosCallback<{ Body: Buffer; headers?: Record<string, string> }>): void;
  headObject(params: Record<string, unknown>, callback: CosCallback<{ headers?: Record<string, string> }>): void;
  getObjectUrl(params: Record<string, unknown>, callback: CosCallback<{ Url: string }>): void;
  /** 可选：假客户端不实现它时后端不暴露 `delete`。 */
  deleteObject?(params: Record<string, unknown>, callback: CosCallback<unknown>): void;
};

export type CosConfig = {
  secretId: string;
  secretKey: string;
  bucketName: string;
  bucketUrl: string;
  region: string;
  prefix: string;
};

export const COS_STORAGE_PLUGIN_ID = "cos-storage";
export const COS_STORAGE_BACKEND_ID = "cos";
export const COS_STORAGE_LABEL = "COS / S3 对象存储";
export const COS_STORAGE_CONFIG_PREFIX = "storage.cos";

/** 默认签名 URL 有效期（秒）。 */
export const DEFAULT_SIGNED_URL_EXPIRES_SECONDS = 900;

/** 旧环境变量名；顺序即为 `apply` 上报缺项时的检查顺序。 */
export const COS_ENV_KEYS = [
  "COS_SECRET_ID",
  "COS_SECRET_KEY",
  "COS_BUCKET_NAME",
  "COS_BUCKET_URL",
  "COS_PREFIX"
] as const;

export const COS_STORAGE_CONFIG = defineConfigSchema({
  secretId: {
    kind: "string",
    secret: true,
    reload: "hot",
    legacyEnv: "COS_SECRET_ID",
    label: "SecretId",
    description: "腾讯云 COS 的 SecretId"
  },
  secretKey: {
    kind: "string",
    secret: true,
    reload: "hot",
    legacyEnv: "COS_SECRET_KEY",
    label: "SecretKey",
    description: "腾讯云 COS 的 SecretKey"
  },
  bucketName: {
    kind: "string",
    reload: "hot",
    legacyEnv: "COS_BUCKET_NAME",
    label: "存储桶名称",
    description: "COS 存储桶名（含 APPID 后缀）"
  },
  bucketUrl: {
    kind: "url",
    protocols: ["https:", "http:"],
    reload: "hot",
    legacyEnv: "COS_BUCKET_URL",
    label: "存储桶地址",
    description: "COS 存储桶访问域名；region 由它解析"
  },
  prefix: {
    kind: "string",
    reload: "hot",
    legacyEnv: "COS_PREFIX",
    label: "对象前缀",
    description: "对象键前缀；最终键为 <prefix>/media/<key>"
  },
  // 公开临时桶：地址不签名，用于「第三方 API 只能自己拉 http 地址」的场景；
  // 桶内内容由运维侧定期清理。桶名 / 域名 / 前缀由构建期注入或运行期填写，
  // 公开仓库里不带任何具体桶。
  publicEnabled: {
    kind: "boolean",
    reload: "hot",
    legacyEnv: "COS_PUBLIC_ENABLED",
    default: false,
    label: "启用公开临时桶",
    description: "开启后，只存本地的部署也能把素材放到公开桶并拿到可直接拉取的地址；内容会被定期清理"
  },
  publicSecretId: {
    kind: "string",
    secret: true,
    reload: "hot",
    legacyEnv: "COS_PUBLIC_SECRET_ID",
    label: "公开桶 SecretId",
    description: "公开临时桶的 SecretId；留空时复用私有桶凭据"
  },
  publicSecretKey: {
    kind: "string",
    secret: true,
    reload: "hot",
    legacyEnv: "COS_PUBLIC_SECRET_KEY",
    label: "公开桶 SecretKey",
    description: "公开临时桶的 SecretKey；留空时复用私有桶凭据"
  },
  publicBucketName: {
    kind: "string",
    reload: "hot",
    legacyEnv: "COS_PUBLIC_BUCKET_NAME",
    label: "公开桶名称",
    description: "公开临时桶名（含 APPID 后缀）"
  },
  publicBucketUrl: {
    kind: "url",
    protocols: ["https:", "http:"],
    reload: "hot",
    legacyEnv: "COS_PUBLIC_BUCKET_URL",
    label: "公开桶地址",
    description: "公开临时桶访问域名；region 由它解析"
  },
  publicPrefix: {
    kind: "string",
    reload: "hot",
    legacyEnv: "COS_PUBLIC_PREFIX",
    label: "公开桶前缀",
    description: "公开桶内的对象前缀；最终键为 <prefix>/<namespace>/<key>"
  }
});

export type CosStorageConfigValues = {
  publicEnabled?: boolean;
  secretId?: string;
  secretKey?: string;
  bucketName?: string;
  bucketUrl?: string;
  prefix?: string;
  publicSecretId?: string;
  publicSecretKey?: string;
  publicBucketName?: string;
  publicBucketUrl?: string;
  publicPrefix?: string;
};

export type CosConfigResolution =
  | { readonly ok: true; readonly config: CosConfig }
  | { readonly ok: false; readonly missing: readonly string[] };

/**
 * 归一化并校验插件配置。
 *
 * 与旧实现不同：配置不完整**不抛错**，而是返回缺失字段名，由 `apply` 记日志并跳过注册
 * （存储后端可以由别的插件顶上，缺配置不该让宿主启动失败）。
 */
export function resolveCosConfig(input: CosStorageConfigValues): CosConfigResolution {
  const secretId = (input.secretId ?? "").trim();
  const secretKey = (input.secretKey ?? "").trim();
  const bucketName = (input.bucketName ?? "").trim();
  const bucketUrl = (input.bucketUrl ?? "").trim().replace(/\/$/, "");
  const prefix = (input.prefix ?? "").trim().replace(/^\/+|\/+$/g, "");

  const missing: string[] = [];
  if (!secretId) missing.push("secretId");
  if (!secretKey) missing.push("secretKey");
  if (!bucketName) missing.push("bucketName");
  if (!bucketUrl) missing.push("bucketUrl");
  if (!prefix) missing.push("prefix");
  if (missing.length > 0) return { ok: false, missing };

  return { ok: true, config: { secretId, secretKey, bucketName, bucketUrl, prefix, region: resolveCosRegion(bucketUrl) } };
}

/**
 * 从 bucket URL 解析 region。
 *
 * 不对称规则（数据兼容契约，不能「顺手统一」）：`<bucket>.cos.<region>.myqcloud.com` 用
 * region 原值；`<bucket>.cos-<region>.myqcloud.com` 补 `ap-` 前缀。
 */
export function resolveCosRegion(bucketUrl: string): string {
  const hostname = new URL(bucketUrl).hostname;
  const match = /^[^.]+\.cos\.([a-z0-9-]+)\.myqcloud\.com$/i.exec(hostname)
    ?? /^[^.]+\.cos-([a-z0-9-]+)\.myqcloud\.com$/i.exec(hostname);
  if (!match?.[1]) throw new Error(`Invalid COS_BUCKET_URL: ${bucketUrl}`);
  return hostname.includes(".cos-") ? `ap-${match[1]}` : match[1];
}

/** 便于测试注入假的 COS 客户端（第 2 个参数）。 */
export function createCosBackend(
  config: CosConfig,
  cos: CosLike = new COS({
    SecretId: config.secretId,
    SecretKey: config.secretKey
  }) as unknown as CosLike,
  /**
   * 后端身份与能力覆盖。
   *
   * 公开临时桶复用同一套 COS 调用，只是 id / 名称不同、并且**不暴露 `presign`**：
   * 它的地址不签名，签名会给出一条带时效的私有地址，语义完全相反。
   */
  options: { backendId?: string; label?: string; signing?: boolean } = {}
): StorageBackend {
  const base = () => ({ Bucket: config.bucketName, Region: config.region });
  const prefix = config.prefix.replace(/^\/+|\/+$/g, "");
  // core 传进来的 key 已带 namespace（形如 `media/<key>`），这里只加后端自己的前缀，
  // 所以最终键仍是数据兼容的 `${prefix}/${namespace}/${key}`（media 即 `${prefix}/media/${key}`）。
  const keyFor = (key: string) => (prefix ? `${prefix}/${key}` : key);

  const backend: StorageBackend = {
    backendId: options.backendId ?? COS_STORAGE_BACKEND_ID,
    label: options.label ?? COS_STORAGE_LABEL,
    ownerExtensionId: COS_STORAGE_PLUGIN_ID,
    async putStream(key, bytes, contentType, options) {
      options.signal?.throwIfAborted();
      let size = 0;
      const checked = async function* () {
        for await (const chunk of bytes) { options.signal?.throwIfAborted(); size += chunk.length; if (size > options.size) throw new Error("流式对象长度不符"); yield chunk; }
        if (size !== options.size) throw new Error("流式对象长度不符");
      };
      const body = Readable.from(checked());
      const abort = () => body.destroy(new Error("媒体写入已取消"));
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        await new Promise<void>((resolve,reject) => {
          body.once("error",reject);
          cos.putObject({ ...base(), Key: keyFor(key), Body: body, ContentType: contentType, ContentLength: options.size }, error => {
            if(error)reject(error);
            else if(!body.readableEnded || size !== options.size)reject(new Error("流式对象未完整上传"));
            else resolve();
          });
        });
      } finally { options.signal?.removeEventListener("abort", abort); body.destroy(); }
    },
    async put(key, bytes, contentType) {
      // cos-nodejs-sdk-v5 接受 Buffer/Stream/String，不接受 Uint8Array。
      await runCos((callback) =>
        cos.putObject({ ...base(), Key: keyFor(key), Body: Buffer.from(bytes), ContentType: contentType }, callback)
      );
    },
    async get(key): Promise<StorageObject> {
      try {
        const data = await runCos<{ Body: Buffer; headers?: Record<string, string> }>((callback) =>
          cos.getObject({ ...base(), Key: keyFor(key) }, callback)
        );
        return {
          bytes: Buffer.isBuffer(data.Body) ? data.Body : Buffer.from(data.Body),
          contentType: data.headers?.["content-type"] ?? data.headers?.["Content-Type"]
        };
      } catch (error) {
        if (isNotFound(error)) throw new StorageObjectNotFoundError(key);
        throw error;
      }
    },
    async openRead(key, range) {
      const output = new PassThrough();
      output.on("error", () => {});
      cos.getObject({ ...base(), Key: keyFor(key), Output: output,
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) }, error => {
        if (error) output.destroy(isNotFound(error) ? new StorageObjectNotFoundError(key) : error);
      });
      return { bytes: output, cancel: () => {
        if (!output.destroyed) output.destroy(new Error("媒体读取已取消"));
      } };
    },
    async head(key): Promise<StorageObjectStat | null> {
      try {
        const data = await runCos<{ headers?: Record<string, string> }>((callback) =>
          cos.headObject({ ...base(), Key: keyFor(key) }, callback)
        );
        const headers = data.headers ?? {};
        const size = Number(headers["content-length"] ?? headers["Content-Length"]);
        if (!Number.isFinite(size) || size < 0) throw new Error(`无法读取 COS 对象大小：${key}`);
        return { size, contentType: headers["content-type"] ?? headers["Content-Type"] };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    ...(options.signing === false ? {} : { async presign(key, options) {
      const data = await runCos<{ Url: string }>((callback) =>
        cos.getObjectUrl(
          {
            ...base(),
            Key: keyFor(key),
            Sign: true,
            Expires: options?.expiresSeconds ?? DEFAULT_SIGNED_URL_EXPIRES_SECONDS
          },
          callback
        )
      );
      if (!data.Url?.trim()) throw new Error(`无法生成 COS 访问地址：${key}`);
      return data.Url.replace(/^http:\/\//i, "https://");
    } })
  };

  const removeObject = cos.deleteObject;
  if (removeObject) {
    backend.delete = async (key) => {
      await runCos((callback) => removeObject.call(cos, { ...base(), Key: keyFor(key) }, callback));
    };
  }

  return backend;
}

export function createCosStoragePlugin(): ExtensionPlugin<typeof COS_STORAGE_CONFIG.fields> {
  return {
    name: COS_STORAGE_PLUGIN_ID,
    label: COS_STORAGE_LABEL,
    icon: "cloud",
    configPrefix: COS_STORAGE_CONFIG_PREFIX,
    inject: ["log", "storage", "exposer"],
    Config: COS_STORAGE_CONFIG,
    apply(ctx, config) {
      const log = ctx.log.scope(COS_STORAGE_PLUGIN_ID);
      const resolved = resolveCosConfig(config);

      // 私有桶：缺配置只记日志，由 core 的就绪检查决定主存储是否可用。
      if (resolved.ok) {
        const backend = createCosBackend(resolved.config);
        ctx.effect(() => ctx.storage.register(backend));
        log({ event: "cos-storage-activated", backendId: backend.backendId });
      } else {
        log({ event: "cos-storage-unconfigured", missing: [...resolved.missing] });
      }

      // 公开临时桶：**独立于私有桶**。纯本地部署（只配 local-storage）也能开启它，
      // 从而获得「第三方 API 能直接拉取」的地址——这正是它的主要用途。
      if (config.publicEnabled !== true) {
        log({ event: "cos-public-disabled" });
        return;
      }
      const publicResolved = resolveCosPublicConfig({
        ...(config.publicSecretId ? { secretId: config.publicSecretId } : {}),
        ...(config.publicSecretKey ? { secretKey: config.publicSecretKey } : {}),
        ...(config.publicBucketName ? { bucketName: config.publicBucketName } : {}),
        ...(config.publicBucketUrl ? { bucketUrl: config.publicBucketUrl } : {}),
        ...(config.publicPrefix ? { prefix: config.publicPrefix } : {}),
        // 私有桶配了就用它那份凭据（同一操作者的两个桶），否则必须单独配公开桶凭据。
        ...(resolved.ok ? { fallbackSecretId: resolved.config.secretId, fallbackSecretKey: resolved.config.secretKey } : {})
      });
      if (!publicResolved.ok) {
        // 缺凭据时整块跳过：注册一个签不出地址的提供者只会把错误推迟到调用期。
        log({ event: "cos-public-unconfigured", missing: [...publicResolved.missing] });
        return;
      }
      const publicConfig = publicResolved.config;
      const publicBackend = createCosBackend(publicConfig, undefined, {
        backendId: COS_PUBLIC_BACKEND_ID,
        label: COS_PUBLIC_LABEL,
        signing: false
      });
      ctx.effect(() => ctx.storage.register(publicBackend));
      ctx.effect(() =>
        ctx.exposer.register({ ...createCosPublicExposer(publicConfig), default: true })
      );
      log({
        event: "cos-public-activated",
        backendId: COS_PUBLIC_BACKEND_ID,
        bucketName: publicConfig.bucketName,
        bucketUrl: publicConfig.bucketUrl,
        prefix: publicConfig.prefix,
        credentialSource: publicConfig.credentialSource
      });
    }
  };
}

function runCos<T>(invoke: (callback: CosCallback<T>) => void): Promise<T> {
  return new Promise((resolve, reject) => invoke((error, data) => (error ? reject(error) : resolve(data))));
}

function isNotFound(error: unknown): boolean {
  const value = error as CosError | null | undefined;
  return Boolean(value && (value.statusCode === 404 || value.code === "NoSuchKey" || value.code === "NotFound"));
}
