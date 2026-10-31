/**
 * 本地对象存储后端插件（扩展层）。
 *
 * 向 `ctx.storage` 注册 `backendId = "local"` 的本地文件系统后端：core 传进来的 key 已带
 * namespace（形如 `media/sha256-xxx.png`），落到磁盘就是 `${root}/${key}`。这是「完全本地」
 * 的缺省后端 —— 没有 `presign`：本地没有公网身份，字节放在哪它说了算，出不出地址它说了不算。
 *
 * 对外地址的补丁也在这里：本插件可选地注册一个**公开临时桶**提供者（见 `public-bucket.ts`），
 * 把本地字节推到公开只读的对象存储，供第三方 API 直接拉取。它默认关闭、也不是默认提供者
 * （`exposer.primary` 未选就不生效），所以「完全本地」的默认行为不变。
 *
 * contentType 用 sidecar 文件 `${root}/${key}.meta.json` 保存（内容 `{"contentType":"..."}`）：
 * 媒体 verify 会比对 contentType，所以 `put` 必须写 sidecar；读不到 sidecar 时按扩展名推断。
 *
 * 对 `StorageScope` 无感：画布维度只有需要它的后端（server 按 `<canvasId>/...` 拼键）才用，
 * 本地键布局与已存对象保持不变，所以这里刻意不接 scope 参数。
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import {
  defineConfigSchema,
  StorageExposeUnavailableError,
  StorageObjectNotFoundError,
  type ExtensionPlugin,
  type StorageBackend,
  type MediaLocator,
  type StorageObject,
  type StorageObjectStat
} from "@woohaa3/contracts";
import {
  LOCAL_PUBLIC_EXPOSER_ID,
  createPublicBucketExposer,
  publicBucketDefaults,
  resolvePublicBucketConfig,
  type PublicBucketConfig
} from "./public-bucket.js";

export const LOCAL_STORAGE_PLUGIN_ID = "local-storage";
export const LOCAL_STORAGE_BACKEND_ID = "local";
export const LOCAL_STORAGE_LABEL = "本地存储";
export const LOCAL_STORAGE_CONFIG_PREFIX = "storage.local";

/** 缺省存储根目录；相对路径按进程 cwd 解析。 */
export const DEFAULT_LOCAL_STORAGE_ROOT = ".woohaa3/storage";

/** locator 前缀：`media://<backendId>/<key>` 里的 backendId 固定是 `local`。 */
export const LOCAL_STORAGE_LOCATOR_PREFIX = `media://local/`;

/** sidecar 后缀；与对象同目录，删除对象时一并删除。 */
const META_SUFFIX = ".meta.json";

/** 构建期注入的公开桶信息：设置页展示为默认值，运行期也用它兜底。 */
const PUBLIC_BUCKET_DEFAULTS = publicBucketDefaults();

export const LOCAL_STORAGE_CONFIG = defineConfigSchema({
  root: {
    kind: "string",
    default: DEFAULT_LOCAL_STORAGE_ROOT,
    reload: "hot",
    label: "存储根目录",
    description: "本地对象存储根目录；相对路径按进程 cwd 解析"
  },
  // 公开临时桶：本地部署唯一能拿到「第三方自己拉得动」的地址的方式。地址不签名，
  // 桶内内容由运维侧定期清理；开启后也**不会**自动成为部署默认提供者。
  // 桶名 / 域名 / 前缀由构建期注入（WOOHAA3_DEFINES），仓库里不带任何具体桶。
  publicEnabled: {
    kind: "boolean",
    reload: "hot",
    legacyEnv: "COS_PUBLIC_ENABLED",
    default: false,
    label: "启用外链地址",
    description: "开启后可用外链地址把素材推到公开只读存储，拿到可直接拉取的地址；内容会被定期清理"
  },
  publicBucketName: {
    kind: "string",
    ...(PUBLIC_BUCKET_DEFAULTS.bucketName ? { default: PUBLIC_BUCKET_DEFAULTS.bucketName } : {}),
    reload: "hot",
    label: "外链桶名称",
    description: "外链存储桶名（含 APPID 后缀）；留空用构建期注入值"
  },
  publicBucketUrl: {
    kind: "url",
    protocols: ["https:", "http:"],
    ...(PUBLIC_BUCKET_DEFAULTS.bucketUrl ? { default: PUBLIC_BUCKET_DEFAULTS.bucketUrl } : {}),
    reload: "hot",
    label: "外链地址",
    description: "外链存储访问域名；留空用构建期注入值，region 由它解析"
  },
  publicPrefix: {
    kind: "string",
    ...(PUBLIC_BUCKET_DEFAULTS.prefix ? { default: PUBLIC_BUCKET_DEFAULTS.prefix } : {}),
    reload: "hot",
    label: "外链前缀",
    description: "外链存储内的对象前缀；留空用构建期注入值，最终键为 <prefix>/<namespace>/<key>"
  },
  publicSecretId: {
    kind: "string",
    secret: true,
    reload: "hot",
    label: "外链 SecretId",
    description: "公开读写的桶可留空（匿名写入）；否则依次读 COS_PUBLIC_SECRET_ID、COS_SECRET_ID，或复用「COS / S3 对象存储」的凭据"
  },
  publicSecretKey: {
    kind: "string",
    secret: true,
    reload: "hot",
    label: "外链 SecretKey",
    description: "公开读写的桶可留空（匿名写入）；否则依次读 COS_PUBLIC_SECRET_KEY、COS_SECRET_KEY，或复用「COS / S3 对象存储」的凭据"
  }
});

export type LocalStorageConfig = {
  root?: string;
  /** 便于测试注入；缺省为 `process.cwd()`。 */
  cwd?: string;
};

/** 无 sidecar 时的扩展名兜底；不在此表内一律 `application/octet-stream`。 */
const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".json": "application/json"
};

export function inferContentType(key: string): string {
  return CONTENT_TYPE_BY_EXTENSION[path.extname(key).toLowerCase()] ?? "application/octet-stream";
}

/**
 * 把 key 解析成 root 内的绝对路径，并拒绝一切越界形态。
 *
 * 拒绝：空 key、含 NUL、绝对路径（POSIX 或 Windows 盘符）、含 `..` 段、解析后逃出 root。
 * 这些一律抛 `Error`（不是 not-found），调用方不该把它们当作「对象不存在」。
 */
export function resolveLocalObjectPaths(root: string, key: string): { objectPath: string; metaPath: string } {
  if (!key) throw new Error("非法的存储 key：key 不能为空");
  if (key.includes("\0")) throw new Error(`非法的存储 key（包含 NUL 字符）：${key}`);
  if (path.isAbsolute(key) || /^[a-zA-Z]:[\\/]/.test(key)) {
    throw new Error(`非法的存储 key（不允许绝对路径）：${key}`);
  }
  if (key.split(/[\\/]+/).some((segment) => segment === "..")) {
    throw new Error(`非法的存储 key（不允许 .. 段）：${key}`);
  }
  const objectPath = path.resolve(root, key);
  if (objectPath !== root && !objectPath.startsWith(root + path.sep)) {
    throw new Error(`非法的存储 key（解析后逃出存储根目录）：${key}`);
  }
  return { objectPath, metaPath: `${objectPath}${META_SUFFIX}` };
}

/** 读 sidecar 里的 contentType；缺失、损坏或空值都返回 undefined（由调用方按扩展名兜底）。 */
async function readSidecarContentType(metaPath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(metaPath, "utf8");
    const parsed = JSON.parse(raw) as { contentType?: unknown } | null;
    const contentType = parsed?.contentType;
    return typeof contentType === "string" && contentType.trim() !== "" ? contentType : undefined;
  } catch {
    return undefined;
  }
}

/** 与 backend 共享的 root 解析：相对 config.root 按 cwd 解析，空串回落到缺省根目录。 */
export function resolveLocalStorageRoot(config: LocalStorageConfig = {}): string {
  const configured = config.root?.trim();
  return path.resolve(config.cwd ?? process.cwd(), configured && configured !== "" ? configured : DEFAULT_LOCAL_STORAGE_ROOT);
}

/**
 * 构造本地存储后端（便于测试直接使用）。
 *
 * `head` 不存在返回 `null`；`get` 不存在抛 `StorageObjectNotFoundError`；`delete` 同时删除
 * 对象与 sidecar（ENOENT 忽略）。没有 `presign` —— 这是「完全本地」后端的能力边界。
 */
export function createLocalBackend(config: LocalStorageConfig = {}): StorageBackend {
  const root = resolveLocalStorageRoot(config);
  const paths = (key: string) => resolveLocalObjectPaths(root, key);

  /** 读一个对象（get 与 readLocator 共用，授权与错误翻译只有一份）。 */
  const readObject = async (key: string): Promise<StorageObject> => {
    const { objectPath, metaPath } = paths(key);
    let bytes: Buffer;
    try {
      bytes = await readFile(objectPath);
    } catch (error) {
      if (isEnoent(error)) throw new StorageObjectNotFoundError(key);
      throw error;
    }
    return { bytes, contentType: (await readSidecarContentType(metaPath)) ?? inferContentType(key) };
  };

  return {
    backendId: LOCAL_STORAGE_BACKEND_ID,
    label: LOCAL_STORAGE_LABEL,
    ownerExtensionId: LOCAL_STORAGE_PLUGIN_ID,
    async head(key): Promise<StorageObjectStat | null> {
      const { objectPath, metaPath } = paths(key);
      try {
        const info = await stat(objectPath);
        if (!info.isFile()) return null;
        return { size: info.size, contentType: (await readSidecarContentType(metaPath)) ?? inferContentType(key) };
      } catch (error) {
        if (isEnoent(error)) return null;
        throw error;
      }
    },
    async get(key): Promise<StorageObject> {
      return readObject(key);
    },
    async openRead(key, range) {
      const { objectPath } = paths(key);
      const stream = createReadStream(objectPath, range);
      return { bytes: stream, cancel: () => stream.destroy() };
    },
    async putStream(key, bytes, contentType, options) {
      const { objectPath, metaPath } = paths(key);
      await mkdir(path.dirname(objectPath), { recursive: true });
      const temporary = `${objectPath}.${randomUUID()}.tmp`;
      try {
        let size = 0;
        const checked = async function* () {
          for await (const chunk of bytes) { options.signal?.throwIfAborted(); size += chunk.length; if (size > options.size) throw new Error("流式对象长度不符"); yield chunk; }
          if (size !== options.size) throw new Error("流式对象长度不符");
        };
        await pipeline(Readable.from(checked()), createWriteStream(temporary, { flags: "wx" }), { signal: options.signal });
        await writeFile(`${temporary}.meta`, JSON.stringify({ contentType }), "utf8");
        await rename(`${temporary}.meta`, metaPath);
        await rename(temporary, objectPath);
      } finally {
        await rm(temporary, { force: true }); await rm(`${temporary}.meta`, { force: true });
      }
    },
    async put(key, bytes, contentType): Promise<void> {
      const { objectPath, metaPath } = paths(key);
      await mkdir(path.dirname(objectPath), { recursive: true });
      await writeFile(objectPath, bytes);
      // 媒体 verify 比对 contentType：sidecar 必须随对象一起写。
      await writeFile(metaPath, JSON.stringify({ contentType }), "utf8");
    },
    /**
     * 稳定键对应的定位符：`media://local/<key>`。
     *
     * 与 server 后端同一形状。有了它，同一个「位置」既能展示也能被 {@link readLocator} 解析，
     * 不会出现「面板上给了一个地址、粘回去却读不到」的情况。
     */
    async locatorOf(key): Promise<MediaLocator | undefined> {
      return LOCAL_STORAGE_LOCATOR_PREFIX + key;
    },
    /** 按 locator 读字节：只认本后端的 locator，其余交给存储层报错。 */
    async readLocator(locator): Promise<StorageObject> {
      if (!locator.startsWith(LOCAL_STORAGE_LOCATOR_PREFIX)) {
        throw new Error("不是本地存储的 locator");
      }
      return readObject(locator.slice(LOCAL_STORAGE_LOCATOR_PREFIX.length));
    },
    async delete(key): Promise<void> {
      const { objectPath, metaPath } = paths(key);
      await rm(objectPath, { force: true });
      await rm(metaPath, { force: true });
    }
  };
}

export function createLocalStoragePlugin(): ExtensionPlugin<typeof LOCAL_STORAGE_CONFIG.fields> {
  return {
    name: LOCAL_STORAGE_PLUGIN_ID,
    label: LOCAL_STORAGE_LABEL,
    icon: "storage",
    configPrefix: LOCAL_STORAGE_CONFIG_PREFIX,
    inject: ["log", "storage", "exposer", "config"],
    Config: LOCAL_STORAGE_CONFIG,
    apply(ctx, config) {
      const log = ctx.log.scope(LOCAL_STORAGE_PLUGIN_ID);
      const backend = createLocalBackend({ root: config.root });
      ctx.effect(() => ctx.storage.register(backend));
      log({ event: "local-storage-activated", backendId: backend.backendId });

      // 公开临时桶：默认关闭；开启后注册提供者，**不**声明默认，仍要显式选
      // `exposer.primary = local-public` 才生效——推素材上公网不该是隐式后果。
      if (config.publicEnabled !== true) {
        log({ event: "local-public-disabled" });
        return;
      }
      const defaults = publicBucketDefaults();
      const bucketName = (config.publicBucketName ?? "").trim() || (defaults.bucketName ?? "").trim();
      const bucketUrl = ((config.publicBucketUrl ?? "").trim() || (defaults.bucketUrl ?? "").trim()).replace(/\/+$/, "");
      const prefix = ((config.publicPrefix ?? "").trim() || (defaults.prefix ?? "").trim()).replace(/^\/+|\/+$/g, "");
      const missing = [
        ...(bucketName ? [] : ["publicBucketName"]),
        ...(bucketUrl ? [] : ["publicBucketUrl"]),
        ...(prefix ? [] : ["publicPrefix"])
      ];
      if (missing.length > 0) {
        // 桶信息是「推到哪」的前提；凭据可以晚到（cos-storage 比本插件晚装载），所以不在这里判。
        log({ event: "local-public-unconfigured", missing });
        return;
      }
      const resolveConfig = (): PublicBucketConfig => {
        // 凭据按用时的最新配置解析：公开桶自己的 → COS_PUBLIC_* → storage.cos / COS_SECRET_*。
        const shared = ctx.config?.section("storage.cos") ?? {};
        const resolved = resolvePublicBucketConfig({
          ...(config.publicSecretId ? { secretId: config.publicSecretId } : {}),
          ...(config.publicSecretKey ? { secretKey: config.publicSecretKey } : {}),
          ...(typeof shared.secretId === "string" && shared.secretId ? { sharedSecretId: shared.secretId } : {}),
          ...(typeof shared.secretKey === "string" && shared.secretKey ? { sharedSecretKey: shared.secretKey } : {}),
          bucketName,
          bucketUrl,
          prefix,
          env: process.env
        });
        if (!resolved.ok) {
          throw new StorageExposeUnavailableError(`公开临时桶未配置：${resolved.missing.join("、")}`);
        }
        return resolved.config;
      };
      ctx.effect(() =>
        ctx.exposer.register({
          ...createPublicBucketExposer({ resolveConfig, storage: ctx.storage }),
          // 设置页据此把「打开该提供者的配置」链回本插件。
          ownerExtensionId: LOCAL_STORAGE_PLUGIN_ID
        })
      );
      log({
        event: "local-public-activated",
        exposerId: LOCAL_PUBLIC_EXPOSER_ID,
        bucketName,
        bucketUrl,
        prefix
      });
    }
  };
}

function isEnoent(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === "ENOENT";
}
