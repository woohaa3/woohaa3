/**
 * Application extension API：公开状态读与受保护配置写路由
 * （自 `extension-api.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R15；
 *  change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 1.4/3.3/3.5）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  APPLICATION_EXTENSION_ERROR_STATUS,
  APPLICATION_EXTENSION_LOAD_ACTION,
  decodeApplicationExtensionChangesQuery,
  decodeApplicationExtensionConfigWrite,
  type ApplicationExtensionErrorCode
} from "@woohaa3/contracts";
import type { ApplicationExtensionApiDependencies, ApiLogger } from "./types.js";
import { DEFAULT_WRITE_BODY_BYTES } from "./types.js";
import { assertActions, resolveAuth } from "./auth.js";
import { statusForAccessError } from "../../extensions/access-enforcement.js";
import { readJson, safeUrl, sendError, sendJson } from "./http-helpers.js";

export function handleChanges(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApplicationExtensionApiDependencies,
  log: ApiLogger
): boolean {
  const url = safeUrl(req.url)!;
  const decoded = decodeApplicationExtensionChangesQuery(Object.fromEntries(url.searchParams.entries()));
  if (!decoded.ok) {
    sendError(res, 400, "malformed-request", decoded.message);
    return true;
  }
  log({ event: "extension-changes", status: 200 });
  sendJson(res, 200, deps.controlPlane.changes(decoded.after));
  return true;
}

export async function handleConfigWrite(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApplicationExtensionApiDependencies,
  extensionId: string,
  log: ApiLogger
): Promise<boolean> {
  // 授权在**解析/写入之前**：loopback 不授权，必须经 identity provider + site-access 具名 action。
  const auth = await resolveAuth(req, deps);
  try {
    await assertActions(deps, auth.principal, [APPLICATION_EXTENSION_LOAD_ACTION]);
  } catch (error) {
    const status = statusForAccessError(error) ?? 403;
    log({ event: "extension-config-unauthorized", status, extensionId });
    const code = status === 401 ? "unauthorized" : status === 503 ? "unavailable" : "forbidden";
    sendError(res, status, code, status === 503 ? "授权提供者不可用" : "需要站点管理员授权");
    return true;
  }
  const body = await readJson(req, DEFAULT_WRITE_BODY_BYTES);
  if (body === null) {
    sendError(res, 400, "malformed-request", "请求体不是合法 JSON");
    return true;
  }
  const decoded = decodeApplicationExtensionConfigWrite(body);
  if (!decoded.ok) {
    sendError(res, 400, decoded.code as ApplicationExtensionErrorCode, decoded.message);
    return true;
  }
  const outcome = await deps.controlPlane.write({
    extensionId,
    expectedRevision: decoded.value.expectedRevision,
    enabled: decoded.value.enabled,
    values: decoded.value.values,
    secretRefs: decoded.value.secretRefs,
    actor: auth.actor ?? auth.principal?.subject ?? "unknown"
  });
  if (!outcome.ok) {
    log({ event: "extension-config-write-rejected", status: APPLICATION_EXTENSION_ERROR_STATUS[outcome.code], extensionId, code: outcome.code });
    if (outcome.code === "revision-conflict") {
      sendJson(res, APPLICATION_EXTENSION_ERROR_STATUS[outcome.code], {
        code: outcome.code,
        message: outcome.message,
        currentRevision: outcome.currentRevision
      });
      return true;
    }
    sendError(res, APPLICATION_EXTENSION_ERROR_STATUS[outcome.code], outcome.code, outcome.message);
    return true;
  }
  log({ event: "extension-config-written", status: 200, extensionId, revision: outcome.revision });
  sendJson(res, 200, { revision: outcome.revision, status: outcome.status });
  return true;
}
