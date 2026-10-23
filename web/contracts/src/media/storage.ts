/**
 * `@woohaa3/contracts` 媒体存储中立契约（原 `@woohaa3/media-storage` 并入，任务 9.1）。
 *
 * 只包含契约本身：`MediaStorage`、`MediaObject`、`MediaObjectStat` 与 not-found 错误。
 * 不包含浏览器、COS 或画布实现依赖，所以画布 domain/state 与运行时协议都只依赖这个
 * 中立边界，而不依赖任何具体存储 SDK。
 *
 * 契约仅使用 ES 内置类型，不依赖画布 CRDT、权限或审计实现。
 * 因此本包 `lib` 只需 `ES2022`，也不需要 `@types/node`。
 *
 * 以下字符串是跨进程兼容契约，必须保持稳定：
 * - `code = "MEDIA_OBJECT_NOT_FOUND"` —— 下游按字符串比较（不是 `instanceof`），因为
 *   跨 bundle 的重复类型无法用 `instanceof` 比较。
 * - `name = "MediaObjectNotFoundError"` —— 作为 not-found 判定的兜底。
 * - 消息文本。
 */

export class MediaObjectNotFoundError extends Error {
  readonly code = "MEDIA_OBJECT_NOT_FOUND" as const;

  constructor(public readonly key: string) {
    super(`Media object not found: ${key}`);
    this.name = "MediaObjectNotFoundError";
  }
}

export type MediaObject = {
  bytes: Uint8Array;
  contentType?: string;
};

/**
 * 媒体定位符（locator）：字节物理位置的**不透明**表达，形如 media://<backendId>/<opaque-path>。
 *
 * 只有产出它的存储后端知道怎么解析；task / provider / media / 界面一律原样传递，
 * 不解析、不拼接、不比较内部结构。需要判断「是否同一对象」时问存储层。
 */
export type MediaLocator = string;

/** 粗判一个值是不是 locator（只用于防止把裸键当 locator；不做结构校验）。 */
export function isMediaLocator(value: unknown): value is MediaLocator {
  if (typeof value !== "string" || !value.startsWith("media://")) return false;
  if (/\s/.test(value)) return false;
  const rest = value.slice("media://".length);
  const slash = rest.indexOf("/");
  return slash > 0 && rest.slice(slash + 1).length > 0;
}

export type MediaObjectStat = {
  size: number;
  contentType?: string;
};

/** 服务端按需读取的字节流；消费者退出时取消上游下载。 */
export type MediaObjectStream = {
  bytes: AsyncIterable<Uint8Array>;
  cancel(): void;
};

/**
 * 媒体读写的作用域：属于哪张画布。
 *
 * 媒体服务自己不认识画布路由，只把调用方声明的画布透传给 `ctx.storage`；`local` / `cos`
 * 忽略它，服务端托管存储用它拼键并按画布判权。缺省表示「与画布无关」（扩展素材、独立页）。
 */
export type MediaStorageScope = {
  readonly canvasId: string;
};

export type MediaStorage = {
  put(key: string, bytes: Uint8Array, contentType: string, scope?: MediaStorageScope): Promise<void>;
  get(key: string, scope?: MediaStorageScope): Promise<MediaObject>;
  exists(key: string, scope?: MediaStorageScope): Promise<boolean>;
  stat?(key: string, scope?: MediaStorageScope): Promise<MediaObjectStat>;
  putStream?(key:string,bytes:AsyncIterable<Uint8Array>,contentType:string,options:{size:number;signal?:AbortSignal},scope?:MediaStorageScope):Promise<void>;
  /** 区间为包含两端的字节偏移；省略时读取完整对象，仍按流返回。 */
  openRead?(key: string, range?: { start: number; end: number }, scope?: MediaStorageScope): Promise<MediaObjectStream>;
  getHttpsUrl?(key: string, options?: { expiresSeconds?: number }, scope?: MediaStorageScope): Promise<string>;
  /**
   * 按 locator 读字节（可跨后端）。
   *
   * locator 是不透明串：只有产出的后端知道怎么解析，媒体层只负责把结果交给它的使用方。
   * 未实现表示该部署不支持按 locator 读取。
   */
  readLocator?(locator: MediaLocator): Promise<MediaObject>;
};

/** 按字符串判定 not-found：与 `MediaObjectNotFoundError` 的 `code`/`name` 保持一致。 */
export function isMediaObjectNotFoundError(error: unknown): boolean {
  if (error instanceof MediaObjectNotFoundError) return true;
  const value = error as { code?: unknown; name?: unknown } | null | undefined;
  if (!value) return false;
  return value.code === "MEDIA_OBJECT_NOT_FOUND" || value.name === "MediaObjectNotFoundError";
}
