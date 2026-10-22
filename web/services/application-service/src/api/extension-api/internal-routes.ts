/**
 * Application extension API：内部 work/recovery 路由
 * （自 `extension-api.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R15）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { BROWSER_SYSTEM_PATH_CODE, isBrowserContextRequest, type InternalServiceIdentity } from "@woohaa3/contracts";
import type { ApplicationExtensionApiDependencies, ApiLogger } from "./types.js";
import { headerValue, sendError, sendJson } from "./http-helpers.js";

/**
 * 内部 work/recovery 接口：要求服务令牌；浏览器不可达（ingress 拒绝 /internal/*）。
 *
 * 任务 1.6：内部调用使用与用户 principal **分开**的 `InternalServiceIdentity`；此外，
 * 即使令牌有效，任何浏览器上下文（带 `Origin`/`Referer`/`Cookie`，可能携带用户会话）也被拒绝，
 * 公开浏览器不能凭 service token 进入 system 调用路径。
 */
export function handleInternal(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApplicationExtensionApiDependencies,
  suffix: string,
  log: ApiLogger
): boolean {
  if (isBrowserContextRequest(req.headers)) {
    log({ event: "extension-internal-browser-rejected", status: 403, code: BROWSER_SYSTEM_PATH_CODE });
    sendError(res, 403, BROWSER_SYSTEM_PATH_CODE, "浏览器上下文不得进入内部调用路径");
    return true;
  }
  const token = headerValue(req.headers["x-woohaa3-service-token"]);
  if (!deps.serviceToken || token !== deps.serviceToken) {
    log({ event: "extension-internal-unauthorized", status: 401 });
    sendError(res, 401, "unauthorized", "缺少或无效的服务身份");
    return true;
  }
  const internalService: InternalServiceIdentity = { kind: "service", service: "application", capabilities: ["extension-work"] };
  log({ event: "extension-internal-work", status: 200, service: internalService.service });
  const match = /^\/([^/]+)\/work(?:\/([^/]+)\/resume)?$/.exec(suffix);
  if (!match) {
    sendError(res, 404, "unsupported", "未知的内部插件路由");
    return true;
  }
  const extensionId = decodeURIComponent(match[1]!);
  const workId = match[2] ? decodeURIComponent(match[2]) : undefined;
  if (req.method !== "POST") {
    sendError(res, 405, "unsupported", "方法不允许");
    return true;
  }
  const lease = deps.controlPlane.workLease(extensionId);
  if (!lease) {
    sendError(res, 404, "extension-not-found", "插件未配置工作在途能力");
    return true;
  }
  if (workId) {
    const handle = lease.resume(workId);
    if (!handle) {
      sendError(res, 404, "extension-not-found", "工作引用不存在或已终态");
      return true;
    }
    sendJson(res, 200, { workId: handle.workId, configVersion: handle.configVersion });
    return true;
  }
  const admitted = lease.admit();
  if (!admitted.ok) {
    sendJson(res, 409, { code: admitted.reason === "disabled" ? "unsupported" : "unavailable", reason: admitted.reason });
    return true;
  }
  sendJson(res, 200, admitted);
  return true;
}
