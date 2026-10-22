import { resolveRequestDataContext, type AccessRuntime } from "@woohaa3/contracts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApplicationRequestAuthenticator, ProviderRegistry } from "@woohaa3/application-service";

/** 所有 Identity/Access 实现共用的当前用户读模型，不暴露名单、凭据或 provider 句柄。 */
export function createSessionApi(authenticate: ApplicationRequestAuthenticator, providers: ProviderRegistry, runtime: AccessRuntime = { enabled: true }) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if ((req.url ?? "").split("?")[0] !== "/api/application/session") return false;
    if (req.method !== "GET") { res.statusCode = 405; res.setHeader("Allow", "GET"); res.end(); return true; }
    let status = 200;
    let body: unknown;
    try {
      if (!runtime.enabled) body = { accessControl: false, dataScopeId: runtime.instance.id };
      else {
      const principal = await authenticate(req, "http");
      if (!principal) { status = 401; body = { code: "unauthorized" }; }
      else {
        const policy = providers.siteAccessPolicy();
        if (!policy || (policy.ready && !policy.ready())) throw new Error("Access 未就绪");
        body = { accessControl: true, dataScopeId: resolveRequestDataContext(runtime, principal).dataScope.id, subject: principal.subject, identityProvider: principal.identityProvider, ...(principal.displayName ? { displayName: principal.displayName } : {}), allowedActions: await policy.allowedActions({ principal }), policyVersion: policy.policyVersion() };
      }
      }
    } catch { status = 503; body = { code: "access-provider-unavailable" }; }
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
    return true;
  };
}
