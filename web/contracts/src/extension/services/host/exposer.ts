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
 * `exposer.primary` 的存在。
 *
 * 临时图床（change: 2026-11-07-add-runninghub-llm-and-provider-temporary-hosting）：
 * 提供者在 `temporaryHosting` 上声明「这类地址是临时外链」，并给出稳定优先级、就绪条件与
 * 请求约束。默认策略按用户保存的来源顺序选择；未排序来源按扩展声明优先级及稳定 ID 追加。
 */
import type { StorageScope } from "./storage.js";

/** 没有可用的对外地址：当前后端不能就地签名，也没有配置能出地址的提供者。 */
export class StorageExposeUnavailableError extends Error {
  readonly code = "STORAGE_EXPOSE_UNAVAILABLE" as const;

  constructor(message = "没有可用的临时图床，请检查提供商配置") {
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
  /** 本次请求的素材约束；自动路由据此排除不支持当前素材的临时图床。 */
  readonly request?: StorageExposeRequest;
};

/** 一次请求的素材事实与有效窗口要求。 */
export type StorageExposeRequest = {
  /** `image` / `video` / `audio`；缺省时由 contentType 推断。 */
  readonly mediaKind?: string;
  /** 素材 MIME；缺省时由存储对象补齐。 */
  readonly contentType?: string;
  /** 素材字节数；缺省时由存储对象补齐。 */
  readonly sizeBytes?: number;
  /** 外部任务还需要多久能读到该地址；无法满足时明确失败。 */
  readonly requiredValiditySeconds?: number;
  /** 请求取消；已取消的请求直接失效，不参与回退。 */
  readonly signal?: AbortSignal;
};

/** 临时图床类别：提供商提供的外链，或扩展声明的后备服务。 */
export type TemporaryHostingCategory = "provider" | "builtin";

/** 临时图床对素材的声明约束（缺省表示不限制）。 */
export type TemporaryHostingConstraints = {
  readonly mediaKinds?: readonly string[];
  readonly maxBytes?: number;
};

/**
 * 临时图床能力声明。
 *
 * `priority` 越小越先被自动选中；相同优先级按稳定 `exposerId` 字典序。它独立于提供商配置
 * 页面的排序与注册时序，避免 UI 调整改变实际执行来源。
 */
export type TemporaryHostingDeclaration = {
  readonly category: TemporaryHostingCategory;
  readonly priority?: number;
  readonly constraints?: TemporaryHostingConstraints;
  /**
   * 该来源承诺的有效窗口；用于判断本次请求所需窗口能否被满足。
   *
   * - 数字：来源能确认的最小窗口；
   * - `null`：**明确未知/不承诺**——上游没有返回期限时不能按宿主缺省一天冒充承诺。
   *   未知窗口仍可服务「不要求未来有效性」的请求，但任何正数窗口要求都会排除该来源；
   * - 缺省：沿用「来源只声明了临时图床能力、未单独声明窗口」的历史语义（宿主上限一天），
   *   已有来源不受影响。
   */
  readonly validitySeconds?: number | null;
  /** 配置完整、扩展已启用且上传实现就绪；返回 false 时不能成为候选。 */
  readonly ready?: () => boolean;
  /**
   * 来源自己的就绪说明（可选，例如「未登录」）。能力中心在来源列表里优先显示它，
   * 让「已配置但当前不可用」与「真的没配置」不再混为一谈；只读，不得触发上传或登录。
   */
  readonly statusNote?: () => string | null;
  /**
   * 凭据修订。一次请求在开始前冻结该值，读取完成后再次比对；变化时旧响应不得算作成功。
   * 缺省表示该来源没有可轮换的凭据。
   */
  readonly credentialEpoch?: () => number;
};

/** 只读候选视图：供可用性检查、执行与能力中心共用同一解析结果。 */
export type TemporaryHostingCandidateView = {
  readonly exposerId: string;
  readonly label: string;
  readonly category: TemporaryHostingCategory;
  readonly ownerExtensionId: string | null;
  readonly priority: number;
  /** 凭据/配置就绪（尚无调用证据也只显示已配置）。 */
  readonly configured: boolean;
  /** 当前请求条件下是否可用。 */
  readonly available: boolean;
  /** 来源自己的就绪说明；没有时为 null。 */
  readonly statusNote?: string | null;
  readonly selected: boolean;
  /** 最近一次真实调用失败；与「已验证通过」分开表达。 */
  readonly lastError: string | null;
};

/** 临时图床的生效模式与真实选择。 */
export type TemporaryHostingMode = "auto" | "manual" | "disabled";

export type TemporaryHostingRouteView = {
  readonly mode: TemporaryHostingMode;
  readonly selectionSource: "canvas" | "manual" | "auto" | "none";
  readonly selectedId: string | null;
  readonly candidates: readonly TemporaryHostingCandidateView[];
  /** 当前配置无法解析时的真实原因；可读状态下为 null。 */
  readonly error: string | null;
  readonly lastFailure: { readonly exposerId: string; readonly message: string } | null;
};

/** 本次请求冻结的来源身份；由 core 在开始上传前记录。 */
export type TemporaryHostingLease = {
  readonly exposerId: string;
  readonly ownerExtensionId: string | null;
  readonly credentialEpoch: number | null;
};

/** `available` / 能力中心共用的一次解析输入（不带 key 时只看配置面）。 */
export type TemporaryHostingQuery = {
  readonly namespace?: string;
  readonly scope?: StorageScope;
  readonly request?: StorageExposeRequest;
};

/**
 * 一个对外地址提供者（扩展层插件注册）。
 *
 * `requiresReplica` 是唯一的形态判据：
 * - `true`：字节必须先落在 `targetBackendId`（云端对象存储、服务端托管存储）；
 *   core 在调用 `expose` 之前完成复制，缺对象时从来源读一次（内容寻址，复制幂等）。
 * - `false`：core 不复制，提供者自己把字节弄到该去的地方再给地址——它拿到的是
 *   namespace/key/scope，可以自己去 `ctx.storage` 读。两种典型：CDN 回源签名（字节不动），
 *   以及「公开临时桶」这类**由提供者推送**的目标。
 *
 * 没有临时图床声明的提供者只能被手动选择（兼容旧的 CDN / 服务端签名能力），自动模式不会
 * 把它们排在提供商或内置临时图床前面。
 */
export type StorageExposer = {
  /** 设置在 `exposer.primary`（以及画布级 `exposure`）里引用的 id。 */
  readonly exposerId: string;
  /** 设置页与日志里的显示名。 */
  readonly label?: string;
  /** 提供这个提供者的插件 id（设置页据此跳转到它的配置）。 */
  readonly ownerExtensionId?: string;
  /** 字节是否必须先在 `targetBackendId` 落地（判据见类型说明）。 */
  readonly requiresReplica: boolean;
  /** `requiresReplica` 为 true 时要复制到哪个后端；缺省与 `exposerId` 同名。 */
  readonly targetBackendId?: string;
  /** 临时图床声明；缺省表示只能手动选择。 */
  readonly temporaryHosting?: TemporaryHostingDeclaration;
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
   * 与 `exposer.primary` 的历史配置保持一致。
   */
  list(): readonly StorageExposer[];
  resolve(exposerId: string): StorageExposer | undefined;
  /** 显式选中的地址提供者 id（`exposer.primary`，旧键 `storage.expose`）；自动模式为空。 */
  selectedId(): string | undefined;
  /** 这一次请求能不能拿到地址（同步只看配置面；请求约束在真实 expose 时复核）。 */
  available(namespace: string, scope?: StorageScope, request?: StorageExposeRequest): boolean;
  /**
   * 取外部地址的解析顺序：
   * ① 画布覆盖：指定 id 只用该来源；空串表示禁用。
   * ② 全局显式来源：只用该来源。
   * ③ 自动：按用户保存顺序（未列出的按扩展优先级 / ID 追加）选择合格来源。
   * 可恢复失败时按同一顺序尝试下一个合格来源，每个来源最多一次。
   */
  expose(input: StorageExposeInput): Promise<string>;
  /** 能力中心读取的权威路由快照；只读，不上传、不生成、不改配置。 */
  temporaryHosting(query?: TemporaryHostingQuery): TemporaryHostingRouteView;
};
