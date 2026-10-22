import { resolveRequestDataContext } from "@woohaa3/contracts";
/**
 * Application extension API：请求认证与具名授权
 * （自 `extension-api.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R15；
 *  change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 1.3/1.4/3.3/3.5）。
 *
 * 认证只经注入的 `ApplicationRequestAuthenticator`（由 identity provider 支撑），**只建立一次**
 * 冻结 principal。授权经 `AccessEnforcer.assertAction`（site-access 提供者）；核心不保留
 * `isAdmin`、静态管理员 Token、shared-secret 断言或 admin 认证等级。
 */
import type { IncomingMessage } from "node:http";
import type { AccessAction, ApplicationExtensionAuthLevel, PrincipalContext } from "@woohaa3/contracts";
import type { ExtensionDispatchContext } from "../../extensions/host.js";
import { ForbiddenError, UnauthenticatedError, type AccessEnforcer } from "../../extensions/access-enforcement.js";
import type { ApplicationExtensionApiDependencies } from "./types.js";
import { headerValue } from "./http-helpers.js";

export type ResolvedAuth = {
  accessControl?: boolean;
  dataScope?: import("@woohaa3/contracts").DataScope;
  authLevel: ApplicationExtensionAuthLevel;
  actor?: string;
  principal?: PrincipalContext;
  sessionId?: string;
  /** 新建本地会话时需要下发的 Set-Cookie（宿主 identity port/本地会话解析提供）。 */
  setCookie?: string;
};

/** 一次请求的可信身份解析结果（认证器缺失时视为 public）。 */
export async function resolveAuth(
  req: IncomingMessage,
  deps: ApplicationExtensionApiDependencies,
  transport: "http" | "ws" | "mcp" = "http"
): Promise<ResolvedAuth> {
  const runtime = deps.accessRuntime ?? deps.accessEnforcer?.runtime;
  if (runtime?.enabled === false) {
    // 本地单实例没有登录用户；仍给插件一个**实例 owner**（不是登录主体、没有站点 action），
    // 使个人插件（OAuth/本机 Agent）能在无鉴权开发姿态把数据写进与实例 scope 相同的 owner。
    return {
      authLevel: "public",
      accessControl: false,
      dataScope: runtime.instance,
      principal: { subject: runtime.instance.ownerId, identityProvider: "instance" },
      actor: runtime.instance.ownerId
    };
  }
  const principal = deps.authenticator ? await deps.authenticator(req, transport) : null;
  if (!principal) return { authLevel: "public", accessControl: true };
  return {
    authLevel: "authenticated",
    accessControl: true,
    dataScope: resolveRequestDataContext(runtime ?? { enabled: true }, principal).dataScope,
    actor: principal.displayName ?? principal.subject,
    principal,
    ...(principal.sessionId ? { sessionId: principal.sessionId } : {})
  };
}

/** 认证器是否已配置（未配置时受保护面拒绝，但公开读取仍可用）。 */
export function authenticatorConfigured(deps: ApplicationExtensionApiDependencies): boolean {
  return deps.authenticator !== undefined;
}

/**
 * 校验一组具名 action。
 *
 * - 无 principal：未认证（401）；
 * - action 缺失/未知/无权限：403；
 * - provider 故障：由 enforcer 抛出 503。
 *
 * 必须在副作用/查询**之前**调用；`requiredActions` 为空时不删除任何既有授权（由调用方决定）。
 */
export async function assertActions(
  deps: ApplicationExtensionApiDependencies,
  principal: PrincipalContext | undefined,
  actions: readonly AccessAction[] | undefined
): Promise<void> {
  if ((deps.accessRuntime ?? deps.accessEnforcer?.runtime)?.enabled === false) return;
  if (!actions || actions.length === 0) return;
  if (!principal) throw new UnauthenticatedError();
  const enforcer: AccessEnforcer | undefined = deps.accessEnforcer;
  if (!enforcer) throw new ForbiddenError("站点授权提供者不可用");
  for (const action of actions) {
    await enforcer.assertAction(principal, action);
  }
}

/**
 * 构造宿主注入的 dispatch 上下文：包含可信 principal、会话绑定与 correlationId。
 */
export function buildDispatchContext(
  req: IncomingMessage,
  auth: ResolvedAuth
): ExtensionDispatchContext {
  const correlationId = headerValue(req.headers["x-woohaa3-correlation-id"]);
  return {
    authLevel: auth.authLevel,
    ...(auth.accessControl !== undefined ? { accessControl: auth.accessControl } : {}),
    ...(auth.dataScope ? { dataScope: auth.dataScope } : {}),
    ...(auth.actor ? { actor: auth.actor } : {}),
    ...(auth.principal ? { principal: auth.principal } : {}),
    ...(auth.sessionId ? { sessionId: auth.sessionId } : {}),
    ...(correlationId ? { correlationId } : {})
  };
}
