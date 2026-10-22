/**
 * 本机宿主存储扩展点契约（设计稿：docs/diagrams/storage-extension-point.html）。
 *
 * 存储是与 `ctx.generation` 平级的核心扩展点：core 只有注册表、按设置选用和按能力路由；
 * `local`、`cos`/`s3`、`server` 都是向它注册的扩展层插件。`media` 与 `task` 只是使用方：
 * 拿一个 namespace 视图读写字节、获取外部地址，不知道字节实际存在哪里。
 *
 * 三条口径：
 * - `StorageBackend` 不知道使用方语义，只认 key（`head`/`get`/`put`，可选 `delete`/`presign`）；
 *   namespace 由 core 拼进 key，后端只在最外层加自己的前缀。
 * - 「能被外部访问」是**能力**（后端有没有 `presign`），不是后端类型。
 * - `bucket(namespace)` 每次调用现查当前后端，主存储热切换对使用方无感。
 */

/** 存储对象 not-found。与 `MediaObjectNotFoundError` 一样按字符串判定（跨 bundle 无法用 instanceof）。 */
export class StorageObjectNotFoundError extends Error {
  readonly code = "STORAGE_OBJECT_NOT_FOUND" as const;

  constructor(public readonly key: string) {
    super(`Storage object not found: ${key}`);
    this.name = "StorageObjectNotFoundError";
  }
}

/** 按字符串判定 not-found：与 `StorageObjectNotFoundError` 的 `code`/`name` 保持一致。 */
export function isStorageObjectNotFoundError(error: unknown): boolean {
  if (error instanceof StorageObjectNotFoundError) return true;
  const value = error as { code?: unknown; name?: unknown } | null | undefined;
  if (!value) return false;
  return value.code === "STORAGE_OBJECT_NOT_FOUND" || value.name === "StorageObjectNotFoundError";
}

/**
 * 没有可用的对外地址：主存储没有 `presign`，也没有配置能签名的 expose 后端。
 * 使用方据此给出「请配置对外存储后端」的明确报错，而不是泛化的存储失败。
 */
export class StorageExposeUnavailableError extends Error {
  readonly code = "STORAGE_EXPOSE_UNAVAILABLE" as const;

  constructor(message = "没有可用的对外存储后端：请给 storage.expose 配置支持签名的后端") {
    super(message);
    this.name = "StorageExposeUnavailableError";
  }
}

/** 按字符串判定 expose 不可用。 */
export function isStorageExposeUnavailableError(error: unknown): boolean {
  if (error instanceof StorageExposeUnavailableError) return true;
  const value = error as { code?: unknown; name?: unknown } | null | undefined;
  if (!value) return false;
  return value.code === "STORAGE_EXPOSE_UNAVAILABLE" || value.name === "StorageExposeUnavailableError";
}

export type StorageObject = {
  bytes: Uint8Array;
  contentType?: string;
};

/** 区间读取的字节流；消费者结束时取消上游。 */
export type StorageObjectStream = {
  bytes: AsyncIterable<Uint8Array>;
  cancel(): void;
};

export type StorageObjectStat = {
  size: number;
  contentType?: string;
};

/**
 * 一个存储后端（扩展层插件注册）。
 *
 * `head`/`get` 不存在时分别返回 `null` / 抛 `StorageObjectNotFoundError`；
 * `presign` 存在即表示该后端能把对象暴露成外部可访问的 HTTPS 地址。
 */
/**
 * 画布作用域：一次读写属于哪张画布。
 *
 * 只有**需要画布维度**的后端会用它（服务端托管存储按 `<canvasId>/<...>` 拼键并按画布判权）；
 * `local` / `cos` 忽略它，键布局与已存对象保持不变。使用方拿不到作用域语义，只负责把
 * 「这次读写发生在哪张画布」透传下来。
 */
export type StorageScope = {
  readonly canvasId: string;
};

export type StorageBackend = {
  /** 设置在 `storage.primary` / `storage.expose` 里引用的 id。 */
  readonly backendId: string;
  /** 设置页与日志里的显示名。 */
  readonly label?: string;
  /**
   * 提供这个后端的插件 id（宿主扩展或站点扩展）。
   *
   * 设置页用它在「选哪个后端」旁边给出「打开该后端配置」的跳转；缺省时设置页只能按配置前缀猜，
   * 站点扩展（没有配置前缀）会退化成「未找到提供者」。
   */
  readonly ownerExtensionId?: string;
  /**
   * 声明这个后端承载**画布托管存储**（至多一个）。
   *
   * 归属远端的画布，字节就写在这个后端里；core 的路由不再硬编码任何后端 id，
   * 只问「这张画布是否由画布托管后端承载」并在这里找到承载者——接入扩展换 id、
   * 换实现都不用改 core。多个后端同时声明时按注册顺序取第一个并记告警；
   * 都不声明时画布读写一律走高主存储（纯本地部署）。
   */
  readonly canvasScoped?: boolean;
  /** `scope` 由 core 透传；不感知画布的后端可以忽略它。 */
  head(key: string, scope?: StorageScope): Promise<StorageObjectStat | null>;
  get(key: string, scope?: StorageScope): Promise<StorageObject>;
  openRead?(key: string, range?: { start: number; end: number }, scope?: StorageScope): Promise<StorageObjectStream>;
  put(key: string, bytes: Uint8Array, contentType: string, scope?: StorageScope): Promise<void>;
  delete?(key: string, scope?: StorageScope): Promise<void>;
  presign?(key: string, options?: { expiresSeconds?: number }, scope?: StorageScope): Promise<string>;
};

/** namespace 视图：使用方给 key，core 拼上 namespace，后端再加自己的前缀。 */
export type StorageBucket = {
  readonly namespace: string;
  /** 视图绑定的画布作用域（缺省为无画布）。 */
  readonly scope?: StorageScope;
  /** 当前生效的后端 id；每次调用现查，画布路由与主存储切换后立即反映。 */
  backendId(): string;
  head(key: string): Promise<StorageObjectStat | null>;
  get(key: string): Promise<StorageObject>;
  openRead?(key: string, range?: { start: number; end: number }): Promise<StorageObjectStream>;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  delete?(key: string): Promise<void>;
  /** 是否能给出外部地址（主存储有 presign，或配置了可签名的 expose 后端）。 */
  canExpose(): boolean;
  /**
   * 取外部地址的解析顺序：
   * ① 主存储有 `presign` → 直接签名；
   * ② 否则用 `storage.expose` 后端：`head` 缺对象时从主存储复制过去再签名（key 内容寻址，复制幂等）；
   * ③ 都没有 → `StorageExposeUnavailableError`。
   */
  expose(key: string, options?: { expiresSeconds?: number }): Promise<string>;
};

/** `ctx.storage`：存储后端的注册面与使用方入口。与 `ctx.generation` 同形。 */
export type HostStorageService = {
  /** 注册后端；返回注销函数（插件放进 `ctx.effect`，卸载时自动注销）。 */
  register(backend: StorageBackend): () => void;
  unregister(backendId: string): void;
  list(): readonly StorageBackend[];
  resolve(backendId: string): StorageBackend | undefined;
  /**
   * 使用方入口：每次调用现查当前后端。
   *
   * 带 `scope` 时先按画布路由（宿主可回答「这张画布同步到了远端」），未命中再回落主存储；
   * 不带 `scope` 时行为与旧版一致（只看 `storage.primary`）。
   */
  bucket(namespace: string, scope?: StorageScope): StorageBucket;
  /**
   * 把对象复制到指定后端（画布资产补传/回填用）。
   *
   * 目标已有同一对象时直接返回 `false`（内容寻址，复制幂等）；来源与目标相同时也返回
   * `false`。仅当真的写入目标后端时返回 `true`。
   *
   * `sourceBackendId` 缺省取「带 scope 时的路由后端、否则主存储」；回填存量资产时要显式给
   * 主存储，因为路由到远端后它已经不含旧对象。
   */
  replicate(
    namespace: string,
    key: string,
    options: { targetBackendId: string; scope?: StorageScope; sourceBackendId?: string }
  ): Promise<boolean>;
  /** 设置 `storage.primary` 的值（缺省 `local`）。 */
  primaryId(): string;
  /** 设置 `storage.expose` 的值；空表示只用主存储的签名能力。 */
  exposeId(): string | undefined;
  /** 就绪只看主存储：主存储后端没注册即未就绪。 */
  readiness(): { ready: boolean; reason?: string };
};
