/**
 * `ctx.exposer`：对外地址（exposure）扩展点契约。
 *
 * 与 `ctx.storage` 的分工：
 * - `ctx.storage` 管**字节驻留**（head/get/put），回答「字节在哪」；
 * - `ctx.exposer` 管**地址投影**，回答「怎么把某个对象变成外部可访问的 URL」。
 *
 * 两者生命周期不同，所以是两个服务：存储缺失时整个宿主不可用（进就绪门槛）；对外地址缺失
 * 只影响「把 URL 交给远端」的那类任务（生成 API 拉参考素材），不参与启动就绪。
 *
 * 为什么 `presign` 仍在 `StorageBackend` 上：它是「这个后端能就地产出地址」的存量能力，
 * 继续留在后端上不影响拆分；对外地址的**选择与复制**全部搬到这里，后端不再需要知道
 * `storage.expose` 的存在。
 */
import type { StorageScope } from "./storage.js";

/** 没有可用的对外地址：当前后端不能就地签名，也没有配置能出地址的提供者。 */
export class StorageExposeUnavailableError extends Error {
  readonly code = "STORAGE_EXPOSE_UNAVAILABLE" as const;

  constructor(message = "没有可用的对外地址：请给 storage.expose 配置支持签名的后端或地址提供者") {
    super(message);
    this.name = "StorageExposeUnavailableError";
  }
}

/** 按字符串判定 expose 不可用（跨 bundle 无法用 instanceof）。 */
export function isStorageExposeUnavailableError(error: unknown): boolean {
  if (error instanceof StorageExposeUnavailableError) return true;
  const value = error as { code?: unknown; name?: unknown } | null | undefined;
  if (!value) return false;
  return value.code === "STORAGE_EXPOSE_UNAVAILABLE" || value.name === "StorageExposeUnavailableError";
}

/** 一次取地址请求：namespace 与 key 由使用方给，core 拼成对象键。 */
export type StorageExposeInput = {
  readonly namespace: string;
  readonly key: string;
  readonly scope?: StorageScope;
  readonly expiresSeconds?: number;
};

/**
 * 一个对外地址提供者（扩展层插件注册）。
 *
 * `requiresReplica` 是唯一的形态判据：
 * - `true`：字节必须先落在 `targetBackendId`（云端对象存储、服务端托管存储）；
 *   core 在调用 `expose` 之前完成复制，缺对象时从来源读一次（内容寻址，复制幂等）。
 * - `false`：字节不需要搬家（例如 CDN 回源签名：源站仍在对象存储里）。core 不复制，提供者自己决定怎么
 *   让那个 URL 可达——它拿到的是 namespace/key/scope，可以自己去 `ctx.storage` 读。
 */
export type StorageExposer = {
  /** 设置在 `storage.expose`（以及画布级 `exposure`）里引用的 id。 */
  readonly exposerId: string;
  /** 设置页与日志里的显示名。 */
  readonly label?: string;
  /** 提供这个提供者的插件 id（设置页据此跳转到它的配置）。 */
  readonly ownerExtensionId?: string;
  /**
   * 未显式配置 `exposer.primary`、画布也没有 exposure 覆盖时，是否直接用它。
   *
   * 内置的「公开临时桶」用它实现「打开开关就生效」：不需要用户再去找设置项填 id。
   * 多个默认项同时注册时按注册顺序取第一个（与 `canvasScoped` 同一取舍）。
   */
  readonly default?: boolean;
  readonly requiresReplica: boolean;
  /** `requiresReplica` 为 true 时要复制到哪个后端；缺省与 `exposerId` 同名。 */
  readonly targetBackendId?: string;
  expose(input: StorageExposeInput): Promise<string>;
};

/** `ctx.exposer`：地址提供者注册面与解析入口。 */
export type HostExposerService = {
  /** 注册提供者；返回注销函数（插件放进 `ctx.effect`，卸载时自动注销）。 */
  register(exposer: StorageExposer): () => void;
  unregister(exposerId: string): void;
  /**
   * 可选的提供者：注册过的，加上「后端自带 `presign`」的隐式提供者（id 即 backendId）。
   *
   * 隐式项让 cos / server 这类能就地签名的后端不必再写一份 exposer，也让设置页的下拉值
   * 与 `storage.expose` 的历史配置保持一致。
   */
  list(): readonly StorageExposer[];
  resolve(exposerId: string): StorageExposer | undefined;
  /** 部署默认的地址提供者 id（`storage.expose`）；空表示只用后端自己的签名能力。 */
  selectedId(): string | undefined;
  /** 这一次请求能不能拿到地址。 */
  available(namespace: string, scope?: StorageScope): boolean;
  /**
   * 取外部地址的解析顺序：
   * ① 当前后端（含画布路由）能就地签名 → 直接签，不复制；
   * ② 否则用画布记录 / 部署默认选中的提供者；`requiresReplica` 时缺对象先复制过去；
   * ③ 都没有 → `StorageExposeUnavailableError`。
   */
  expose(input: StorageExposeInput): Promise<string>;
};
