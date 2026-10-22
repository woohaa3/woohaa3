/**
 * 通用身份、站点授权、资源策略与生命周期契约（纯类型）
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 0.3 / design D1/D2/D5）。
 *
 * 宿主只认识这些**通用**契约：它不内置企业网关算法、管理员名单或四模式 ACL。企业身份、
 * 站点管理员名单与画布分享规则分别由 Identity、`site-access`、Access
 * 扩展提供。核心 MUST NOT 出现 `isAdmin`、`roles.includes('admin')` 或 admin 认证等级。
 *
 * 认证是**异步**的：HTTP、WS upgrade、MCP 与扩展调用都经同一提供者建立一次冻结
 * `PrincipalContext`，下游不得再读取未经验证的来路 principal/actor 头。
 */

/** 站点/资源具名 action。未知 action 默认拒绝（不保留旧 admin 到新权限的万能映射）。 */
export const ACCESS_ACTIONS = [
  /** 扩展站点配置写/启停。 */
  "extensions.configure",
  /** Provider 凭据写/清除。 */
  "providers.credentials.write",
  /** 模型运营策略管理。 */
  "models.manage",
  /** 全局任务监控读。 */
  "tasks.inspect",
  /**
   * 本机遥测复盘读与清空（change: 2026-10-20-add-local-client-telemetry）。
   *
   * 与 `tasks.inspect` 分开而不是复用：遥测记录的是本机客户端行为事实（编辑/保存/同步的成败与
   * 耗时），与任务执行历史是不同的数据面，把两者绑成一个权限会让"只想看任务监控"的人也拿到
   * 本机行为数据。
   */
  "telemetry.inspect"
] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];

export function isAccessAction(value: unknown): value is AccessAction {
  return typeof value === "string" && (ACCESS_ACTIONS as readonly string[]).includes(value);
}

/** 站点配置写/启停使用的具名 action（宿主配置写入路径与扩展配置面共用）。 */
export const APPLICATION_EXTENSION_LOAD_ACTION: AccessAction = "extensions.configure";
/** Provider 凭据写/清除使用的具名 action。 */
export const PROVIDERS_CREDENTIALS_ACTION: AccessAction = "providers.credentials.write";
/** 模型运营策略管理使用的具名 action。 */
export const MODELS_MANAGE_ACTION: AccessAction = "models.manage";
/** 全局任务监控读使用的具名 action。 */
export const TASKS_INSPECT_ACTION: AccessAction = "tasks.inspect";
/** 本机遥测复盘读/清空使用的具名 action（change: 2026-10-20-add-local-client-telemetry）。 */
export const TELEMETRY_INSPECT_ACTION: AccessAction = "telemetry.inspect";

/** 资源权限：与站点 action 正交；站点管理资格不隐式授予任何资源权限。 */
export const RESOURCE_PERMISSIONS = ["read", "write", "manageSharing", "delete"] as const;
export type ResourcePermission = (typeof RESOURCE_PERMISSIONS)[number];

export function isResourcePermission(value: unknown): value is ResourcePermission {
  return typeof value === "string" && (RESOURCE_PERMISSIONS as readonly string[]).includes(value);
}

/**
 * 宿主体内的**可信、冻结**principal 上下文（定义见 `principal.ts`，此处仅重导出以免重复）。
 */
export type { PrincipalContext } from "./principal.js";
import type { PrincipalContext } from "./principal.js";

/** 认证传输面：HTTP、WS upgrade、MCP 与扩展调用共用同一提供者。 */
export const IDENTITY_TRANSPORTS = ["http", "ws", "mcp"] as const;
export type IdentityTransport = (typeof IDENTITY_TRANSPORTS)[number];

/**
 * 一次认证请求。**只含原始受控输入**：provider 自己判断可信来源，不能仅凭代理地址或
 * 转发头判定登录。
 */
export type IdentityAuthenticateInput = {
  transport: IdentityTransport;
  /** 原始请求头（结构形状，不 import node:http）。 */
  headers: Readonly<Record<string, string | string[] | undefined>>;
  method?: string;
  url?: string;
  /** 直连远端地址（仅用于 provider 判断是否 loopback 直连；不能替代密码学验证）。 */
  remoteAddress?: string;
  /** 认证时刻（毫秒；由宿主注入以便测试确定化）。 */
  now?: number;
};

export type IdentityFailureCode =
  /** 没有可识别身份。 */
  | "unauthenticated"
  /** 身份存在但非法/过期/签名错误（不区分细节以免泄漏）。 */
  | "invalid";

export type IdentityAuthenticateResult =
  | { ok: true; principal: PrincipalContext }
  | { ok: false; code: IdentityFailureCode; message?: string };

/**
 * 身份提供者。由可信部署 profile 按 extensionId 引用；必需提供者缺失/故障时保护面拒绝。
 *
 * `providerId` 是供给槽位 identity（稳定字符串），与 extensionId 分开，允许多提供者实现
 * 共存时仍按 profile 选择。
 */
export type IdentityProvider = {
  providerId: string;
  /** 认证一次请求；未认证返回 `{ok:false}`，绝不抛出来源不明的成功。 */
  authenticate(input: IdentityAuthenticateInput): Promise<IdentityAuthenticateResult>;
  /** 可选：当前提供者是否已就绪（配置完整）。缺省视为就绪。 */
  ready?(): boolean;
};

/** 站点 action 决策。provider 故障与用户无权限必须区分（503 vs 403）。 */
export type AccessDecision =
  | { allowed: true }
  | { allowed: false; code: "unauthenticated" }
  | { allowed: false; code: "forbidden" }
  | { allowed: false; code: "provider-unavailable"; message?: string };

export function accessDenied(code: Exclude<AccessDecision, { allowed: true }>["code"], message?: string): AccessDecision {
  return code === "provider-unavailable" ? { allowed: false, code, ...(message ? { message } : {}) } : { allowed: false, code };
}

/** 站点管理授权提供者（`site-access` 拥有管理员名单与四个具名 action）。 */
export type SiteAccessPolicy = {
  policyId: string;
  /** 安全 policy 版本（可返回给当前用户；不含名单）。 */
  policyVersion(): string;
  /** 当前用户自身允许的 action（用于界面资格；服务端仍重查）。 */
  allowedActions(input: { principal: PrincipalContext }): Promise<readonly AccessAction[]>;
  /** 具名 action 决策；在副作用/查询前调用。 */
  authorize(input: { principal: PrincipalContext; action: AccessAction }): Promise<AccessDecision>;
  /** provider 是否就绪；缺省视为就绪。 */
  ready?(): boolean;
};

/** 资源（画布）身份：本期只支持 canvas。 */
export type ResourceRef = { kind: "canvas"; id: string };

export type ResourceAccessDecision =
  | { allowed: true; permission: ResourcePermission }
  | { allowed: false; code: "not-found" | "forbidden" | "unauthenticated" | "provider-unavailable"; message?: string };

/**
 * 资源访问提供者（Access 拥有 ACL 与四模式规则）。
 *
 * 宿主的 Canvas/Task/MCP/extension 全部相关入口消费同一决策；不允许存在性放行。
 */
export type ResourceAccessPolicy = {
  policyId: string;
  authorize(input: {
    principal: PrincipalContext;
    resource: ResourceRef;
    permission: ResourcePermission;
  }): Promise<ResourceAccessDecision>;
  /** 当前主体可发现的资源集合（我的目录）由目录 contribution 提供，见 ResourceDirectory。 */
  ready?(): boolean;
};

/** 资源目录条目：只读摘要（不含 Y.Doc/store 句柄，也不泄漏 ACL 名单）。 */
export type ResourceDirectoryEntry = {
  resource: ResourceRef;
  title: string;
  revision: number;
  updatedAt: string;
  nodeCount: number;
};

/**
 * 资源发现目录提供者（Access 拥有成员索引）：
 * 当前主体**可读**的资源集合，与「我的目录」同一发现规则（先按 subject 过滤，再稳定排序分页）。
 *
 * 宿主把它接到 Agent 的 `list_canvases`（本文件任务 4.4/6.5）：未提供或故障时目录为空（fail
 * closed），绝不退回「列出全库画布」。
 */
export type ResourceDirectory = {
  directoryId: string;
  list(input: {
    principal: PrincipalContext;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: ResourceDirectoryEntry[]; nextCursor?: string }>;
  /**
   * 当前主体**可发现集合**的 ID 全量（不分页，与 `list` 同一发现规则）。
   *
   * 「可发现集合」按 spec 只含主体创建/指定协作及已登记的无属主 legacy——**不**等于「所有
   * 可链接读取的画布」（everyone 链接 MUST NOT 自动进入发现列表）。供同源目录列表在分页
   * **之前**过滤（否则只会列出恰好落在某一页的项，散落在后续页的项永远不可见）。
   * 缺省时调用方回退翻页收集；失败/未提供即视为空（fail closed），绝不退回列出全库。
   */
  listDiscoverableIds?(input: { principal: PrincipalContext }): Promise<string[]>;
  ready?(): boolean;
};

/** 资源生命周期阶段（provisioning 不公开；deleting 断开读者）。 */
export const RESOURCE_LIFECYCLE_STATES = ["provisioning", "active", "deleting", "deleted"] as const;
export type ResourceLifecycleState = (typeof RESOURCE_LIFECYCLE_STATES)[number];

/**
 * 资源生命周期提供者（Access 拥有 ACL reservation/finalize/tombstone）。
 *
 * 宿主使用稳定 operationId + owner 串行协调 reserve→create→finalize，并持久化 receipt 以
 * 支持崩溃恢复；不能先公开资源再异步补 owner。
 */
export type ResourceLifecyclePolicy = {
  policyId: string;
  /**
   * 为可信 owner 预留资源（返回 provisioning ACL；不公开）。
   *
   * 崩溃恢复：同一 owner 用同一 `operationId` 重试时返回 `resumed: true` 并沿用既有预留，
   * 宿主据此判断内容可能已由上一次尝试创建（change: 2026-10-13-...，任务 11.2 / D1）。
   */
  reserve(input: {
    principal: PrincipalContext;
    resource: ResourceRef;
    operationId: string;
  }): Promise<{ ok: true; aclRevision: number; resumed?: boolean } | { ok: false; code: string; message: string }>;
  /** 内容创建成功后激活 ACL（active 才可发现/打开）。 */
  finalize(input: {
    principal: PrincipalContext;
    resource: ResourceRef;
    operationId: string;
  }): Promise<{ ok: true; aclRevision: number } | { ok: false; code: string; message: string }>;
  /** 内容删除成功后保存 tombstone。 */
  tombstone(input: {
    principal: PrincipalContext;
    resource: ResourceRef;
    operationId: string;
  }): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  /**
   * 删除开始：把资源置为 `deleting`（对所有读者不可读并断开读者），幂等（change: 2026-10-13-...，任务 5.2）。
   *
   * 在删除权威内容**之前**调用；内容删除成功后用 `tombstone` 终结。删除失败时宿主用 `finalize`
   * 复原为 active（可恢复，不产生无属主孤儿）。缺失时不写入中间态（旧实现兼容）。
   */
  beginDelete?(input: {
    principal: PrincipalContext;
    resource: ResourceRef;
    operationId: string;
  }): Promise<{ ok: true; aclRevision: number } | { ok: false; code: string; message: string }>;
  /**
   * 取消未完成的预留（内容创建失败的补偿；change: 2026-10-13-...，任务 11.2 / D1）。
   *
   * 只在该预留仍属于同一 principal + `operationId` 且仍为 provisioning 时移除（连同成员索引），
   * 不触碰 active/deleted 记录。缺省实现表示不支持（宿主跳过，预留留给重试或启动结算）。
   */
  cancelReservation?(input: {
    principal: PrincipalContext;
    resource: ResourceRef;
    operationId: string;
  }): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  /**
   * 启动期结算遗留 provisioning 预留（崩溃恢复；change: 2026-10-13-...，任务 11.2 / D1）。
   *
   * 宿主提供内容存在性判定：内容已存在 → 补 finalize；内容不存在 → 清理预留。只结算早于
   * `reservedBefore` 的预留（避免与在途创建竞争）。幂等，可每次启动执行。
   */
  reconcileProvisioning?(input: {
    exists(resourceId: string): Promise<boolean>;
    reservedBefore?: string;
  }): Promise<{ finalized: string[]; cleaned: string[]; failed: string[] }>;
  ready?(): boolean;
};

/** 必需基础提供者槽位：profile 只引用 extensionId。 */
export const REQUIRED_PROVIDER_SLOTS = [
  "identity",
  "site-access",
  "resource-access",
  "resource-lifecycle"
] as const;
export type RequiredProviderSlot = (typeof REQUIRED_PROVIDER_SLOTS)[number];

/**
 * 可选基础提供者槽位：不参与必需 profile 的 bootstrap 校验，缺失时消费方 fail closed。
 *
 * `resource-directory` 由 Access 登记（我的目录/Agent 目录同一发现规则）；宿主把它接到
 * Canvas 的 Agent 目录。它不是「必需」因为独立运行的 Application Service 无需它也能启动。
 */
export const OPTIONAL_PROVIDER_SLOTS = ["resource-directory"] as const;
export type OptionalProviderSlot = (typeof OPTIONAL_PROVIDER_SLOTS)[number];

export type ProviderSlot = RequiredProviderSlot | OptionalProviderSlot;

/** 启动装配明确指定每个必需能力的 owner，不按扩展名称猜测。 */
export type RequiredProviderProfile = { slot: RequiredProviderSlot; extensionId: string };
export type RequiredProviderProfiles = readonly RequiredProviderProfile[];

/** 提供者故障时的稳定错误码（HTTP 503）。 */
export const ACCESS_PROVIDER_UNAVAILABLE_CODE = "access-provider-unavailable" as const;

/**
 * 内部服务身份（change: 2026-10-13-...，任务 1.6）。
 *
 * 与用户 `PrincipalContext` **分离**的类型：内部服务（Task projector、extension work、grant
 * 校验等）不是用户，不携带 subject，也**不能**被转换成用户 principal，因此不能扩大用户委托。
 * `system` 调用路径只接受该身份，绝不接受浏览器会话。
 */
export type InternalServiceIdentity = {
  kind: "service";
  /** 稳定服务标识（例如 "application"、"task"、"canvas"）；不是用户 subject。 */
  service: string;
  /** 明确能力清单；缺省为空表示不具备任何 system 能力。 */
  capabilities: readonly InternalServiceCapability[];
};

/** 内部服务能力（system 投影只持明确 job/run 能力）。 */
export type InternalServiceCapability =
  /** 站点插件工作在途准入/恢复。 */
  | "extension-work"
  /** Task 终态向画布投影。 */
  | "task-projection"
  /** 受控媒体导入/签名（Task 专属作用域）。 */
  | "media-sign"
  | "media-import"
  /** 画布对象核验。 */
  | "media-verify";

/** 内部服务路径的稳定拒绝码：公开浏览器上下文不得进入 system 调用路径。 */
export const BROWSER_SYSTEM_PATH_CODE = "browser-cannot-enter-system" as const;

/**
 * 判定请求是否来自浏览器上下文（可能携带用户会话）。
 *
 * 服务间调用不带 `origin`/`referer`/`cookie`；浏览器一定会带其一。内部/system 路径据此拒绝
 * 任何浏览器来源 —— 即使它持有有效的 service token，也不能借用户会话进入 system 调用路径。
 */
export function isBrowserContextRequest(
  headers: Readonly<Record<string, string | string[] | undefined>>
): boolean {
  const has = (name: string): boolean => {
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (value === undefined) return false;
    return (Array.isArray(value) ? value.join("") : value).trim() !== "";
  };
  return has("origin") || has("referer") || has("cookie");
}
