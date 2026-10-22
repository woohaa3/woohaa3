/**
 * 宿主统一执行边界：认证、action 检查与资源检查
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 1.3/1.4/1.6）。
 *
 * 这是 HTTP、WS、MCP 与 handler/facade 共用的**唯一**执行边界：
 * - 每请求只认证一次，得到冻结 `PrincipalContext`；
 * - `assertAction` 在副作用/查询前调用（缺失/未知 action 默认拒绝）；
 * - `assertResource` 消费 ResourceAccessPolicy（不允许存在性放行）。
 *
 * 未认证 401、无权限 403、provider 故障 503。绝不回退 loopback、旧 Token 或匿名。
 */
import type {
  AccessAction,
  AccessRuntime,
  AccessDecision,
  IdentityAuthenticateInput,
  IdentityProvider,
  PrincipalContext,
  ResourceAccessDecision,
  ResourceAccessPolicy,
  ResourcePermission,
  ResourceRef,
  SiteAccessPolicy
} from "@woohaa3/contracts";
import { AccessProviderUnavailableError } from "./provider-registry.js";

/** 认证失败（401）。 */
export class UnauthenticatedError extends Error {
  readonly code = "unauthenticated" as const;
  constructor(message = "未认证") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

/** 身份可信但无权限（403）。 */
export class ForbiddenError extends Error {
  readonly code = "forbidden" as const;
  constructor(message = "无权限") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** 资源不存在/不可见（404；不泄漏存在性）。 */
export class ResourceNotFoundError extends Error {
  readonly code = "resource-not-found" as const;
  constructor(message = "资源不存在") {
    super(message);
    this.name = "ResourceNotFoundError";
  }
}

export type RequestAuthenticator = {
  /** 建立可信 principal；未认证返回 null（不抛错，便于 handler 分层）。 */
  authenticate(input: IdentityAuthenticateInput): Promise<PrincipalContext | null>;
};

export function createRequestAuthenticator(provider: IdentityProvider): RequestAuthenticator {
  return {
    async authenticate(input) {
      const result = await provider.authenticate(input);
      return result.ok ? result.principal : null;
    }
  };
}

/** 从 Node 请求建立 identity provider 输入（只包含原始受控输入，不含派生授权）。 */
export function identityInputFromHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  transport: import("@woohaa3/contracts").IdentityTransport,
  extra: { method?: string; url?: string; remoteAddress?: string; now?: number } = {}
): IdentityAuthenticateInput {
  return {
    transport,
    headers,
    ...(extra.method !== undefined ? { method: extra.method } : {}),
    ...(extra.url !== undefined ? { url: extra.url } : {}),
    ...(extra.remoteAddress !== undefined ? { remoteAddress: extra.remoteAddress } : {}),
    ...(extra.now !== undefined ? { now: extra.now } : {})
  };
}

/** 冻结 principal（浅拷贝 + 冻结 attributes），防止下游改写可信身份。 */
export function freezePrincipal(principal: PrincipalContext): PrincipalContext {
  const frozen: PrincipalContext = {
    subject: principal.subject,
    identityProvider: principal.identityProvider,
    ...(principal.displayName !== undefined ? { displayName: principal.displayName } : {}),
    ...(principal.sessionId !== undefined ? { sessionId: principal.sessionId } : {}),
    ...(principal.validUntil !== undefined ? { validUntil: principal.validUntil } : {}),
    ...(principal.attributes !== undefined ? { attributes: Object.freeze({ ...principal.attributes }) } : {})
  };
  return Object.freeze(frozen);
}

export type AccessEnforcer = {
  readonly runtime?: AccessRuntime;
  /** 站点 action 检查；失败抛 UnauthenticatedError/ForbiddenError/AccessProviderUnavailableError。 */
  assertAction(context: PrincipalContext | null | undefined, action: AccessAction): Promise<void>;
  /** 资源检查；返回决策（不抛错，便于 handler 区分 not-found/forbidden）。 */
  checkResource(
    context: PrincipalContext | null | undefined,
    resource: ResourceRef,
    permission: ResourcePermission
  ): Promise<ResourceAccessDecision>;
  /**
   * 资源检查（抛错版）：allowed 返回；not-found → ResourceNotFoundError；forbidden → ForbiddenError；
   * provider 故障 → AccessProviderUnavailableError。
   */
  assertResource(context: PrincipalContext | null | undefined, resource: ResourceRef, permission: ResourcePermission): Promise<void>;
  /** 当前用户自身 allowedActions（界面资格；服务端仍重查）。 */
  allowedActions(context: PrincipalContext | null | undefined): Promise<readonly AccessAction[]>;
};

export function createAccessEnforcer(options: {
  runtime?: AccessRuntime;
  siteAccessPolicy: () => SiteAccessPolicy | null;
  resourceAccessPolicy: () => ResourceAccessPolicy | null;
}): AccessEnforcer {
  const requireSite = (): SiteAccessPolicy => {
    try {
      const policy = options.siteAccessPolicy();
      if (!policy || (policy.ready && !policy.ready())) throw new Error();
      return policy;
    } catch { throw new AccessProviderUnavailableError("站点授权提供者不可用"); }
  };
  const requireResource = (): ResourceAccessPolicy => {
    try {
      const policy = options.resourceAccessPolicy();
      if (!policy || (policy.ready && !policy.ready())) throw new Error();
      return policy;
    } catch { throw new AccessProviderUnavailableError("资源访问提供者不可用"); }
  };
  const providerCall = async <T>(call: () => Promise<T>): Promise<T> => {
    try { return await call(); }
    catch (error) {
      if (error instanceof UnauthenticatedError) throw error;
      throw new AccessProviderUnavailableError("授权提供者运行失败");
    }
  };

  const decide = (decision: AccessDecision): void => {
    if (decision.allowed) return;
    if (decision.code === "unauthenticated") throw new UnauthenticatedError();
    if (decision.code === "provider-unavailable") throw new AccessProviderUnavailableError(decision.message ?? "授权提供者不可用");
    throw new ForbiddenError();
  };

  const requirePrincipal = (context: PrincipalContext | null | undefined): PrincipalContext => {
    if (!context) throw new UnauthenticatedError();
    return context;
  };
  return {
    ...(options.runtime ? { runtime: options.runtime } : {}),
    async assertAction(context, action) {
      if (options.runtime?.enabled === false) return;
      const decision = await providerCall(() => requireSite().authorize({ principal: requirePrincipal(context), action }));
      decide(decision);
    },
    async checkResource(context, resource, permission) {
      if (options.runtime?.enabled === false) return { allowed: true, permission };
      return providerCall(() => requireResource().authorize({ principal: requirePrincipal(context), resource, permission }));
    },
    async assertResource(context, resource, permission) {
      if (options.runtime?.enabled === false) return;
      const decision = await providerCall(() => requireResource().authorize({ principal: requirePrincipal(context), resource, permission }));
      if (decision.allowed) return;
      if (decision.code === "not-found") throw new ResourceNotFoundError();
      if (decision.code === "unauthenticated") throw new UnauthenticatedError();
      if (decision.code === "provider-unavailable") {
        throw new AccessProviderUnavailableError(decision.message ?? "资源访问提供者不可用");
      }
      throw new ForbiddenError();
    },
    async allowedActions(context) {
      if (options.runtime?.enabled === false) return [];
      return providerCall(() => requireSite().allowedActions({ principal: requirePrincipal(context) }));
    }
  };
}

/** 把执行边界错误映射为稳定 HTTP 状态（401/403/404/503）。 */
export function statusForAccessError(error: unknown): number | null {
  const code = (error as { code?: string }).code;
  if (code === "unauthenticated") return 401;
  if (code === "forbidden") return 403;
  if (code === "resource-not-found") return 404;
  if (code === "access-provider-unavailable") return 503;
  return null;
}
