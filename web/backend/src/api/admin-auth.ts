/**
 * 保护面授权：统一执行边界（认证一次 + 具名 action）
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 1.4/3.2）。
 *
 * 不再有静态管理员令牌、`isAdmin` 角色或 loopback 放行：受控部署的主体只来自注入的异步
 * `ApplicationRequestAuthenticator`（由 identity provider 支撑），授权只由
 * `AccessEnforcer.assertAction` 按其具名 action 判定。本地单实例
 * （`accessRuntime.enabled=false`）不认证、不要求 action。
 *
 * 返回稳定状态：未认证 401、无权限 403、提供者故障 503；调用方据此回写响应。
 */
import type { IncomingMessage } from "node:http";
import type { AccessAction, PrincipalContext } from "@woohaa3/contracts";
import { statusForAccessError, type AccessEnforcer, type ApplicationRequestAuthenticator } from "@woohaa3/application-service";

export type AdminAuthDependencies = {
  authenticator?: ApplicationRequestAuthenticator;
  accessEnforcer?: AccessEnforcer;
};

export type AdminAuthResult =
  | { ok: true; actor: string; principal: PrincipalContext | null }
  | { ok: false; status: number; code: "unauthorized" | "forbidden" };

export async function authorizeAdmin(
  req: IncomingMessage,
  deps: AdminAuthDependencies,
  action: AccessAction
): Promise<AdminAuthResult> {
  try {
    const controlled = deps.accessEnforcer?.runtime?.enabled !== false;
    const principal = controlled && deps.authenticator ? await deps.authenticator(req, "http") : null;
    if (controlled && !principal) return { ok: false, status: 401, code: "unauthorized" };
    if (!deps.accessEnforcer) throw Object.assign(new Error("授权提供者不可用"), { code: "access-provider-unavailable" });
    await deps.accessEnforcer.assertAction(principal, action);
    return { ok: true, actor: principal?.displayName ?? principal?.subject ?? "instance", principal };
  } catch (error) {
    const status = statusForAccessError(error) ?? 403;
    return { ok: false, status, code: status === 403 ? "forbidden" : "unauthorized" };
  }
}
