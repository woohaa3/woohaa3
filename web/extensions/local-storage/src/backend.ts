/**
 * 本地对象存储后端插件（扩展层）。
 *
 * 向 `ctx.storage` 注册 `backendId = "local"` 的本地文件系统后端：core 传进来的 key 已带
 * namespace（形如 `media/sha256-xxx.png`），落到磁盘就是 `${root}/${key}`。这是「完全本地」
 * 的缺省后端 —— 没有 `presign`，因此不宣称任何对外暴露能力（需要外部地址时由 core 用
 * `storage.expose` 指定的可签名后端解决）。
 *
 * contentType 用 sidecar 文件 `${root}/${key}.meta.json` 保存（内容 `{"contentType":"..."}`）：
 * 媒体 verify 会比对 contentType，所以 `put` 必须写 sidecar；读不到 sidecar 时按扩展名推断。
 *
 * 对 `StorageScope` 无感：画布维度只有需要它的后端（server 按 `<canvasId>/...` 拼键）才用，
 * 本地键布局与已存对象保持不变，所以这里刻意不接 scope 参数。
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  defineConfigSchema,
  StorageObjectNotFoundError,
  type HostExtensionPlugin,
  type StorageBackend,
  type StorageObject,
  type StorageObjectStat
} from "@woohaa3/contracts";

export const LOCAL_STORAGE_PLUGIN_ID = "local-storage";
export const LOCAL_STORAGE_BACKEND_ID = "local";
export const LOCAL_STORAGE_LABEL = "本地存储";
export const LOCAL_STORAGE_CONFIG_PREFIX = "storage.local";

/** 缺省存储根目录；相对路径按进程 cwd 解析。 */
export const DEFAULT_LOCAL_STORAGE_ROOT = ".woohaa3/storage";

/** sidecar 后缀；与对象同目录，删除对象时一并删除。 */
const META_SUFFIX = ".meta.json";

export const LOCAL_STORAGE_CONFIG = defineConfigSchema({
  root: {
    kind: "string",
    default: DEFAULT_LOCAL_STORAGE_ROOT,
    reload: "hot",
    label: "存储根目录",
    description: "本地对象存储根目录；相对路径按进程 cwd 解析"
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
      const { objectPath, metaPath } = paths(key);
      let bytes: Buffer;
      try {
        bytes = await readFile(objectPath);
      } catch (error) {
        if (isEnoent(error)) throw new StorageObjectNotFoundError(key);
        throw error;
      }
      return { bytes, contentType: (await readSidecarContentType(metaPath)) ?? inferContentType(key) };
    },
    async put(key, bytes, contentType): Promise<void> {
      const { objectPath, metaPath } = paths(key);
      await mkdir(path.dirname(objectPath), { recursive: true });
      await writeFile(objectPath, bytes);
      // 媒体 verify 比对 contentType：sidecar 必须随对象一起写。
      await writeFile(metaPath, JSON.stringify({ contentType }), "utf8");
    },
    async delete(key): Promise<void> {
      const { objectPath, metaPath } = paths(key);
      await rm(objectPath, { force: true });
      await rm(metaPath, { force: true });
    }
  };
}

export function createLocalStoragePlugin(): HostExtensionPlugin<typeof LOCAL_STORAGE_CONFIG.fields> {
  return {
    name: LOCAL_STORAGE_PLUGIN_ID,
    label: LOCAL_STORAGE_LABEL,
    icon: "storage",
    configPrefix: LOCAL_STORAGE_CONFIG_PREFIX,
    inject: ["log", "storage"],
    Config: LOCAL_STORAGE_CONFIG,
    apply(ctx, config) {
      const backend = createLocalBackend({ root: config.root });
      ctx.effect(() => ctx.storage.register(backend));
      ctx.log.scope(LOCAL_STORAGE_PLUGIN_ID)({ event: "local-storage-activated", backendId: backend.backendId });
    }
  };
}

function isEnoent(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === "ENOENT";
}
