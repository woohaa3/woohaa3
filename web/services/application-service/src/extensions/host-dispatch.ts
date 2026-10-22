/**
 * Application 后端插件宿主：注册面与 dispatch
 * （自 `host.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R16）。
 *
 * 只接受受控 `HostRegistryContext`（唯一 owner 表与版本 visibility），不创建第二份状态。
 */
import { isAuthLevelAtLeast, type ApplicationBackendHandlerRegistration, type ApplicationBackendHttpHandlerRegistration, type ApplicationBackendRawHttpHandlerRegistration, type ApplicationExtensionHandlerResult, type ApplicationExtensionHttpMethod, type ApplicationExtensionHttpRequest, type ApplicationExtensionHttpResponse, type ApplicationExtensionRawRequest, type ApplicationExtensionRawResponse, type ApplicationExtensionRequestContext } from "./contract.js";
import {
  DEFAULT_HANDLER_STATUS,
  ExtensionHostError,
  httpHandlerKey,
  type ExtensionDispatchContext,
  type OwnerState
} from "./host-types.js";

export type HostRegistryContext = {
  owners: Map<string, OwnerState>;
  globalHandlers: Map<string, string>;
  globalHttpHandlers: Map<string, string>;
  globalRawHttpHandlers: Map<string, string>;
  log: (event: Record<string, unknown>) => void;
};

/** 构造宿主注入的请求上下文（可信身份，不含插件自报）。 */
export function buildRequestContext(extensionId: string, input: ExtensionDispatchContext): ApplicationExtensionRequestContext {
  return {
    extensionId,
    authLevel: input.authLevel,
    ...(input.accessControl !== undefined ? { accessControl: input.accessControl } : {}),
    ...(input.dataScope ? { dataScope: input.dataScope } : {}),
    ...(input.actor ? { actor: input.actor } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.principal ? { principal: input.principal } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  };
}

export async function dispatchHandler(
  ctx: HostRegistryContext,
  route: string,
  input: { body: unknown; context: ExtensionDispatchContext; extensionId?: string }
): Promise<ApplicationExtensionHandlerResult> {
  const found = findHandlerRegistration(ctx, route, input.extensionId);
  if (!found) {
    throw new ExtensionHostError("handler-not-found", `未注册的插件路由：${route}`);
  }
  const { owner, registration } = found;
  if (input.extensionId !== undefined && owner.extensionId !== input.extensionId) {
    ctx.log({ event: "extension-handler-owner-mismatch", route, expected: input.extensionId, actual: owner.extensionId });
    throw new ExtensionHostError("handler-not-found", "插件路由不属于目标插件");
  }
  if (input.context.accessControl !== false && !isAuthLevelAtLeast(input.context.authLevel, registration.auth)) {
    ctx.log({ event: "extension-handler-unauthorized", route, extensionId: owner.extensionId, auth: input.context.authLevel });
    throw new ExtensionHostError("unauthorized", "调用者认证等级不足");
  }
  const result = await registration.handle({
    body: input.body,
    context: buildRequestContext(owner.extensionId, input.context)
  });
  return { status: result.status ?? DEFAULT_HANDLER_STATUS, body: result.body };
}

/**
 * 解析 handler registration（change: 2026-10-13-...，任务 1.1）。
 *
 * 全局 handler 键按 `extensionId/route` 命名空间隔离，使不同扩展可各自声明同名 route（如 `me`、
 * `session`）而不冲突。优先解析命名空间键；测试/进程内调用省略 extensionId 时按声明 route 回退查找。
 */
export function findHandlerRegistration(
  ctx: HostRegistryContext,
  route: string,
  extensionId?: string
): { owner: OwnerState; registration: ApplicationBackendHandlerRegistration } | undefined {
  if (extensionId !== undefined) {
    const key = `${extensionId}/${route}`;
    const ownerId = ctx.globalHandlers.get(key);
    const owner = ownerId ? ctx.owners.get(ownerId) : undefined;
    const registration = owner?.handlers.get(key);
    return owner && registration ? { owner, registration } : undefined;
  }
  // 未指定 extensionId（进程内工具调用/测试）：按声明 route 扫描 owner 表。
  for (const owner of ctx.owners.values()) {
    for (const registration of owner.handlers.values()) {
      if (registration.route === route) return { owner, registration };
    }
  }
  return undefined;
}

export function findHttpRegistration(
  ctx: HostRegistryContext,
  method: ApplicationExtensionHttpMethod,
  route: string
): { owner: OwnerState; registration: ApplicationBackendHttpHandlerRegistration } | undefined {
  const exactOwnerId = ctx.globalHttpHandlers.get(httpHandlerKey(method, route));
  if (exactOwnerId) {
    const owner = ctx.owners.get(exactOwnerId);
    const registration = owner?.httpHandlers.get(httpHandlerKey(method, route));
    if (owner && registration) return { owner, registration };
  }
  for (const owner of [...ctx.owners.values()].sort((a, b) => a.order - b.order)) {
    if (owner.mode !== "public") continue;
    for (const [, registration] of owner.httpHandlers) {
      if (registration.method !== method) continue;
      if (!registration.route.endsWith("/*")) continue;
      const prefix = registration.route.slice(0, -1);
      if (route === registration.route.slice(0, -2) || route.startsWith(prefix)) {
        return { owner, registration };
      }
    }
  }
  return undefined;
}

export function findRawHttpRegistration(
  ctx: HostRegistryContext,
  method: ApplicationExtensionHttpMethod,
  route: string
): { owner: OwnerState; registration: ApplicationBackendRawHttpHandlerRegistration } | undefined {
  const exactOwnerId = ctx.globalRawHttpHandlers.get(httpHandlerKey(method, route));
  if (exactOwnerId) {
    const owner = ctx.owners.get(exactOwnerId);
    const registration = owner?.rawHttpHandlers.get(httpHandlerKey(method, route));
    if (owner && registration) return { owner, registration };
  }
  for (const owner of [...ctx.owners.values()].sort((a, b) => a.order - b.order)) {
    if (owner.mode !== "public") continue;
    for (const [, registration] of owner.rawHttpHandlers) {
      if (registration.method !== method) continue;
      if (!registration.route.endsWith("/*")) continue;
      const prefix = registration.route.slice(0, -1);
      if (route === registration.route.slice(0, -2) || route.startsWith(prefix)) {
        return { owner, registration };
      }
    }
  }
  return undefined;
}

export async function dispatchHttp(
  ctx: HostRegistryContext,
  input: {
    method: ApplicationExtensionHttpMethod;
    route: string;
    req: ApplicationExtensionHttpRequest;
    res: ApplicationExtensionHttpResponse;
    context: ExtensionDispatchContext;
  }
): Promise<{ registration: ApplicationBackendHttpHandlerRegistration } | undefined> {
  const found = findHttpRegistration(ctx, input.method, input.route);
  if (!found) return undefined;
  const { owner, registration } = found;
  if (input.context.accessControl !== false && !isAuthLevelAtLeast(input.context.authLevel, registration.auth)) {
    ctx.log({ event: "extension-http-handler-unauthorized", route: input.route, method: input.method, extensionId: owner.extensionId, auth: input.context.authLevel });
    throw new ExtensionHostError("unauthorized", "调用者认证等级不足");
  }
  await registration.handle(input.req, input.res);
  return { registration };
}

export async function dispatchRawHttp(
  ctx: HostRegistryContext,
  input: {
    method: ApplicationExtensionHttpMethod;
    route: string;
    req: ApplicationExtensionRawRequest;
    res: ApplicationExtensionRawResponse;
    context: ExtensionDispatchContext;
  }
): Promise<{ registration: ApplicationBackendRawHttpHandlerRegistration } | undefined> {
  const found = findRawHttpRegistration(ctx, input.method, input.route);
  if (!found) return undefined;
  const { owner, registration } = found;
  if (input.context.accessControl !== false && !isAuthLevelAtLeast(input.context.authLevel, registration.auth)) {
    ctx.log({ event: "extension-raw-http-handler-unauthorized", route: input.route, method: input.method, extensionId: owner.extensionId, auth: input.context.authLevel });
    throw new ExtensionHostError("unauthorized", "调用者认证等级不足");
  }
  await registration.handle(input.req, input.res, buildRequestContext(owner.extensionId, input.context));
  return { registration };
}

export function resolvePublicRoute(
  ctx: HostRegistryContext,
  extensionId: string,
  route: string,
  method: ApplicationExtensionHttpMethod
): { owned: boolean } {
  const found = findHttpRegistration(ctx, method, route) ?? findRawHttpRegistration(ctx, method, route);
  return { owned: found?.owner.extensionId === extensionId && found.owner.mode === "public" };
}
