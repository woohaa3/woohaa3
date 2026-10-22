/**
 * Application extension API：受控 handler 分派路由
 * （自 `extension-api.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R15）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApplicationExtensionApiDependencies, ApiLogger, ApplicationExtensionHandlerLimits } from "./types.js";
import { assertActions, buildDispatchContext, resolveAuth } from "./auth.js";
import { statusForAccessError } from "../../extensions/access-enforcement.js";
import { readJson, sendError, withTimeout } from "./http-helpers.js";

export async function handleExtensionHandler(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApplicationExtensionApiDependencies,
  limits: ApplicationExtensionHandlerLimits,
  extensionId: string,
  route: string,
  log: ApiLogger
): Promise<boolean> {
  const host = deps.host;
  // 历史版本恢复 namespace 只供进程内恢复；不能借公共 handler URL 访问。
  if (route.startsWith("_recovery/")) {
    sendError(res, 404, "extension-not-found", "未注册的插件路由");
    return true;
  }
  if (!host) {
    sendError(res, 404, "extension-not-found", "插件宿主不可用");
    return true;
  }
  const status = deps.controlPlane.status(extensionId);
  const registration = host.snapshot().filter(entry => entry.extensionId === extensionId)
    .flatMap(entry => entry.handlers).find(handler => handler.route === route);
  const controlsExistingWork = registration?.purpose === "work-control" || registration?.purpose === "read";
  if (!status || (status.actualState !== "active" && !(status.actualState === "draining" && controlsExistingWork))) {
    log({ event: "extension-handler-unavailable", status: 404, extensionId, actualState: status?.actualState });
    sendError(res, 404, "extension-not-found", "插件未激活");
    return true;
  }
  const auth = await resolveAuth(req, deps);
  const body = await readJson(req, limits.maxRequestBytes);
  if (body === null) {
    sendError(res, 400, "malformed-request", "请求体不是合法 JSON");
    return true;
  }
  try {
    // 具名 action 在进入插件逻辑前校验（change: 2026-10-13-...，任务 1.4/3.3）。
    await assertActions(deps, auth.principal, registration?.requiredActions);
    const result = await withTimeout(
      host.dispatch(route, {
        body,
        extensionId,
        context: buildDispatchContext(req, auth)
      }),
      limits.timeoutMs
    );
    const payload = JSON.stringify(result.body ?? null);
    if (Buffer.byteLength(payload) > limits.maxResponseBytes) {
      sendError(res, 502, "unsupported", "插件响应超出体积上限");
      return true;
    }
    res.statusCode = result.status ?? 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
    res.end(payload);
    return true;
  } catch (error) {
    const accessStatus = statusForAccessError(error);
    if (accessStatus === 401) {
      log({ event: "extension-handler-unauthorized", status: 401, extensionId, route });
      sendError(res, 401, "unauthorized", "认证等级不足");
      return true;
    }
    if (accessStatus === 403) {
      log({ event: "extension-handler-forbidden", status: 403, extensionId, route });
      sendError(res, 403, "forbidden", "缺少所需站点权限");
      return true;
    }
    if (accessStatus === 503) {
      log({ event: "extension-handler-provider-unavailable", status: 503, extensionId, route });
      sendError(res, 503, "unavailable", "授权提供者不可用");
      return true;
    }
    const code = (error as { code?: string }).code;
    if (code === "unauthorized") {
      log({ event: "extension-handler-unauthorized", status: 401, extensionId, route });
      sendError(res, 401, "unauthorized", "认证等级不足");
      return true;
    }
    if (code === "handler-not-found") {
      sendError(res, 404, "extension-not-found", "未注册的插件路由");
      return true;
    }
    log({ event: "extension-handler-failed", status: 500, extensionId, route });
    sendError(res, 500, "storage-failed", "插件 handler 执行失败");
    return true;
  }
}
