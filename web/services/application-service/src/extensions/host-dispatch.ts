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
  type ExtensionRecord
} from "./host-types.js";

export type HostRegistryContext = {
  /** 唯一的注册表（键见 `ExtensionRecord`）。 */
  records: Map<string, ExtensionRecord>;
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
): { owner: ExtensionRecord; registration: ApplicationBackendHandlerRegistration } | undefined {
  if (extensionId !== undefined) {
    const key = `${extensionId}/${route}`;
    const ownerId = ctx.globalHandlers.get(key);
    const owner = ownerId ? ctx.records.get(ownerId) : undefined;
    const registration = owner?.handlers.get(key);
    return owner && registration ? { owner, registration } : undefined;
  }
  // 未指定 extensionId（进程内工具调用/测试）：按声明 route 扫描 owner 表。
  for (const owner of ctx.records.values()) {
    for (const registration of owner.handlers.values()) {
      if (registration.route === route) return { owner, registration };
    }
  }
  return undefined;
}

/**
 * 按「扩展 identity + 相对 route」查找 HTTP 注册。
 *
 * 注册时全局键是 `<extensionId>/<route>`；分派时**必须**用同一个 extensionId 拼键，
 * 否则跨扩展同名 route 会互相串（`/login` 属于谁全看注册顺序）。
 * `extensionId` 缺省时退化为「按原始 route 查」，只用于宿主内部/测试的旧调用形态。
 */
export function findHttpRegistration(
  ctx: HostRegistryContext,
  method: ApplicationExtensionHttpMethod,
  route: string,
  extensionId?: string
): { owner: ExtensionRecord; registration: ApplicationBackendHttpHandlerRegistration } | undefined {
  const keyRoute = extensionId === undefined ? route : namespacedRoute(extensionId, route);
  const exactOwnerId = ctx.globalHttpHandlers.get(httpHandlerKey(method, keyRoute));
  if (exactOwnerId) {
    const owner = ctx.records.get(exactOwnerId);
    const registration = owner?.httpHandlers.get(httpHandlerKey(method, keyRoute));
    if (owner && registration) return { owner, registration };
  }
  for (const owner of [...ctx.records.values()].sort((a, b) => a.order - b.order)) {
    if (owner.mode !== "public") continue;
    if (extensionId !== undefined && owner.extensionId !== extensionId) continue;
    for (const [, registration] of owner.httpHandlers) {
      if (registration.method !== method) continue;
      if (!isWildcardRoute(registration.route)) continue;
      // 通配注册的键也带 extensionId 前缀，因此用同一个 keyRoute 前缀比较即可。
      if (matchesWildcard(owner.extensionId, registration.route, keyRoute)) {
        return { owner, registration };
      }
    }
  }
  return undefined;
}

/** 按「扩展 identity + 相对 route」查找 raw HTTP 注册（同 `findHttpRegistration`）。 */
export function findRawHttpRegistration(
  ctx: HostRegistryContext,
  method: ApplicationExtensionHttpMethod,
  route: string,
  extensionId?: string
): { owner: ExtensionRecord; registration: ApplicationBackendRawHttpHandlerRegistration } | undefined {
  const keyRoute = extensionId === undefined ? route : namespacedRoute(extensionId, route);
  const exactOwnerId = ctx.globalRawHttpHandlers.get(httpHandlerKey(method, keyRoute));
  if (exactOwnerId) {
    const owner = ctx.records.get(exactOwnerId);
    const registration = owner?.rawHttpHandlers.get(httpHandlerKey(method, keyRoute));
    if (owner && registration) return { owner, registration };
  }
  for (const owner of [...ctx.records.values()].sort((a, b) => a.order - b.order)) {
    if (owner.mode !== "public") continue;
    if (extensionId !== undefined && owner.extensionId !== extensionId) continue;
    for (const [, registration] of owner.rawHttpHandlers) {
      if (registration.method !== method) continue;
      if (!isWildcardRoute(registration.route)) continue;
      if (matchesWildcard(owner.extensionId, registration.route, keyRoute)) {
        return { owner, registration };
      }
    }
  }
  return undefined;
}

/**
 * 把「扩展声明的相对 route」转成带 extensionId 命名空间的查找键。
 *
 * 注册与分派必须用同一把尺子：注册侧以 `<extensionId>/<route>` 落键，分派侧若不前缀，
 * 就会永远找不到——所以这里统一加，且 `_recovery` 命名空间由注册侧自己带前缀，
 * 分派时仍按「公共实例的 extensionId」拼接。
 */
/** 通配注册：`*`（全部）或 `prefix/*`（前缀）。 */
function isWildcardRoute(route: string): boolean {
  return route === "*" || route.endsWith("/*");
}

/** 判断带命名空间的查找键是否命中某个通配注册。 */
function matchesWildcard(extensionId: string, registered: string, keyRoute: string): boolean {
  const base = `${extensionId}/`;
  if (registered === "*") return keyRoute.startsWith(base) && keyRoute.length > base.length;
  const prefix = `${base}${registered.slice(0, -1)}`;
  const bare = `${base}${registered.slice(0, -2)}`;
  return keyRoute === bare || keyRoute.startsWith(prefix);
}

function namespacedRoute(extensionId: string, route: string): string {
  return `${extensionId}/${route}`;
}


export async function dispatchHttp(
  ctx: HostRegistryContext,
  input: {
    /** 发起调用的扩展 identity（公共实例）；用它的命名空间查注册表。 */
    extensionId: string;
    method: ApplicationExtensionHttpMethod;
    route: string;
    req: ApplicationExtensionHttpRequest;
    res: ApplicationExtensionHttpResponse;
    context: ExtensionDispatchContext;
  }
): Promise<{ registration: ApplicationBackendHttpHandlerRegistration } | undefined> {
  const found = findHttpRegistration(ctx, input.method, input.route, input.extensionId);
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
    /** 发起调用的扩展 identity（公共实例）；用它的命名空间查注册表。 */
    extensionId: string;
    method: ApplicationExtensionHttpMethod;
    route: string;
    req: ApplicationExtensionRawRequest;
    res: ApplicationExtensionRawResponse;
    context: ExtensionDispatchContext;
  }
): Promise<{ registration: ApplicationBackendRawHttpHandlerRegistration } | undefined> {
  const found = findRawHttpRegistration(ctx, input.method, input.route, input.extensionId);
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
  const found = findHttpRegistration(ctx, method, route, extensionId) ?? findRawHttpRegistration(ctx, method, route, extensionId);
  // `mode` 缺省即 public：Cordis 装载的扩展没有 recovery 实例。
  return { owned: found?.owner.extensionId === extensionId && (found.owner.mode ?? "public") === "public" };
}
