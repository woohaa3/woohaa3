/**
 * `ctx.storage` 与存储扩展点契约（设计稿：docs/diagrams/storage-extension-point.html）。
 *
 * 存储是与 `ctx.generation` 平级的核心扩展点：core 只有注册表、按设置选用和按能力路由；
 * `local`、`cos`/`s3`、`server` 都是向它注册的扩展层插件。`media` 与 `task` 只是使用方：
 * 拿一个 namespace 视图读写字节，不知道字节实际存在哪里。
 *
 * 三条口径：
 * - `StorageBackend` 不知道使用方语义，只认 key（`head`/`get`/`put`，可选 `delete`/`presign`）；
 *   namespace 由 core 拼进 key，后端只在最外层加自己的前缀。
 * - 「能被外部访问」是**能力**，但**不再由这个服务解析**：地址投影归 `ctx.exposer`
 *   （见 `./exposer.js`）。本服务只回答「当前后端能不能就地签」这一个事实。
 * - `bucket(namespace, scope)` 每次调用现查当前后端，主存储热切换对使用方无感。
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
 * 对外地址不可用。定义已迁到 `./exposer.js`（地址投影是它的事），这里保留转出，
 * 让既有的 `@woohaa3/contracts` 引用路径不变。
 */
export {
  StorageExposeUnavailableError,
  isStorageExposeUnavailableError
} from "./exposer.js";

export type StorageObject = {
  bytes: Uint8Array;
  contentType?: string;
};

/** 区间读取的字节流；消费者结束时取消上游。 */
import type { MediaLocator } from "../../../media/storage.js";

export type StorageObjectStream = {
  bytes: AsyncIterable<Uint8Array>;
  cancel(): void;
};

export type StorageObjectStat = {
  size: number;
  contentType?: string;
};

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

/**
 * 一张画布的存储形态（画布记录级覆盖，字段级回落到部署默认）。
 *
 * 为什么按画布而不是按部署：同一台机器上可以既有纯本地画布、又有已转换到远端的画布。
 * 为什么带默认值：绝大多数画布不写任何字段，直接继承 `storage.primary` / `storage.expose`；
 * 只有确实需要的画布才留下一条覆盖记录。
 */
export type StorageProfile = {
  /**
   * 字节落点角色。缺省继承部署主存储（`storage.primary`）。
   *
   * `canvas-hosted` 由声明了 `canvasScoped` 的后端兑现——转换流程写入它，界面不提供「取消」：
   * 一旦有字节写进托管存储，它就是事实，撤销要靠迁移而不是改配置。
   */
  readonly residency?: "primary" | "canvas-hosted";
  /**
   * 地址提供者 id（`ctx.exposer` 的 `exposerId`）。缺省继承 `storage.expose`；
   * 空串表示这张画布明确不对外。
   */
  readonly exposure?: string;
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
  /**
   * 就地产出外部地址（存量能力）。
   *
   * 存在即表示「这个后端自己能签」：`ctx.exposer` 会先用它，不复制、不换后端。
   * 不能就地签的后端不要实现它——需要异地转发的场景由 `ctx.exposer` 注册地址提供者。
   */
  presign?(key: string, options?: { expiresSeconds?: number }, scope?: StorageScope): Promise<string>;
  putStream?(key:string,bytes:AsyncIterable<Uint8Array>,contentType:string,options:{size:number;signal?:AbortSignal},scope?:StorageScope):Promise<void>;
  /**
   * 按 locator 读字节（可跨后端）。
   *
   * locator 是不透明串：只有产出它的后端知道怎么解析，实现内部完成授权与取数。
   * 未实现表示该部署不支持按 locator 读取。
   */
  readLocator?(locator: MediaLocator): Promise<StorageObject>;
  /**
   * 给出某个稳定键对应的 locator（写完之后把「新位置」交回调用方）。
   *
   * 实现不了时返回 undefined：调用方据此知道结果不带定位符，而不是自己拼一个前缀。
   */
  locatorOf?(key: string, scope?: StorageScope): Promise<MediaLocator | undefined>;
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
  putStream?(key:string,bytes:AsyncIterable<Uint8Array>,contentType:string,options:{size:number;signal?:AbortSignal}):Promise<void>;
  delete?(key: string): Promise<void>;
};

/** 当前作用域解析到的后端，以及它就地签名的能力（没有 `presign` 时为 undefined）。 */
export type StorageCurrentBackend = {
  readonly backendId: string;
  readonly presign?: (key: string, options?: { expiresSeconds?: number }, scope?: StorageScope) => Promise<string>;
  /**
   * 画布记录里的地址提供者覆盖（未配置时为 undefined）。
   *
   * `exposer` 用它决定这次用哪个提供者：有覆盖就用覆盖（空串表示这张画布明确不对外），
   * 没有才回落部署默认。存储不解释这个值——它只回答「这张画布记了什么」。
   */
  readonly exposure?: string;
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
   * 带 `scope` 时先按画布记录路由，未命中再回落主存储；
   * 不带 `scope` 时行为与旧版一致（只看 `storage.primary`）。
   */
  bucket(namespace: string, scope?: StorageScope): StorageBucket;
  /**
   * 当前作用域会落到哪个后端、能否就地签。
   *
   * 只给 `ctx.exposer` 用：它要决定「直接签」还是「复制到提供者再签」，但不该看到后端对象。
   * 主存储未注册时抛与读写同一条错误。
   */
  current(namespace: string, scope?: StorageScope): StorageCurrentBackend;
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
  /**
   * 按 locator 读字节：解析出 backendId，交给对应后端的 `readLocator`。
   *
   * 这是 locator 的**唯一**解析入口：使用方永远不该自己拆 `media://...`。
   * 后端没实现或 locator 不属于任何已注册后端时报错（显式失败，不回落主存储）。
   */
  readLocator(locator: MediaLocator): Promise<StorageObject>;
  /** 设置 `storage.primary` 的值（缺省 `local`）。 */
  primaryId(): string;
  /** 就绪只看主存储：主存储后端没注册即未就绪。 */
  readiness(): { ready: boolean; reason?: string };
};
