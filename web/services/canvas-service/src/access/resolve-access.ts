/**
 * Canvas 服务资源授权解析
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 4.4/6.1/6.2/6.5 / design D8）。
 *
 * 把宿主注入的 `ResourceAccessPolicy`/`ResourceLifecyclePolicy` 适配成 Canvas 内部使用的
 * 端口与 principal 解析；未注入时返回 fail-closed 端口。Canvas 服务**不**实现 ACL 业务。
 */
import type { PrincipalContext, ResourceAccessPolicy, ResourceLifecyclePolicy, ResourcePermission, ResourceRef } from "@woohaa3/contracts";
import type { CanvasAccessPort, CanvasAccessDecision } from "./access-port.js";
import type { IncomingMessage } from "node:http";

export type { CanvasAccessPort, CanvasAccessRequest, CanvasAccessDecision } from "./access-port.js";
export { createCanvasAccessPort, denyingCanvasAccessPort } from "./access-port.js";

/** Canvas 入口认证接缝：把请求解析为可信 principal（未认证 null）。 */
export type CanvasRequestAuthenticator = (
  req: IncomingMessage,
  transport?: "http" | "ws"
) => Promise<PrincipalContext | null>;

/** fail-closed 端口：未配置资源授权时一律拒绝（不因存在性放行）。 */

/** 把返回 `ResourceAccessDecision` 的策略适配为 Canvas 端口（每次都重新查询策略）。 */
export function canvasAccessFromPolicy(policy: () => ResourceAccessPolicy | null): CanvasAccessPort {
  return {
    async authorize(input): Promise<CanvasAccessDecision> {
      try {
      const current = policy();
      if (!current || (current.ready && !current.ready())) return { allowed: false, code: "provider-unavailable", message: "画布授权提供者不可用" };
      const ref: ResourceRef = { kind: "canvas", id: input.canvasId };
      const decision = await current.authorize({ principal: input.principal, resource: ref, permission: input.permission });
      if (decision.allowed) return { allowed: true };
      const code = decision.code === "not-found" ? "not-found"
        : decision.code === "unauthenticated" ? "unauthenticated"
          : decision.code === "provider-unavailable" ? "provider-unavailable"
            : "forbidden";
      return { allowed: false, code, message: "无权访问该画布" };
      } catch { return { allowed: false, code: "provider-unavailable", message: "画布授权提供者不可用" }; }
    }
  };
}

/** 把授权决策映射为 HTTP 状态与稳定 code（不泄漏存在性：not-found 与 forbidden 分离）。 */
export function httpStatusForCanvasAccess(decision: Extract<CanvasAccessDecision, { allowed: false }>): { status: number; code: string } {
  switch (decision.code) {
    case "unauthenticated": return { status: 401, code: "UNAUTHORIZED" };
    case "provider-unavailable": return { status: 503, code: "NOT_READY" };
    case "not-found": return { status: 404, code: "CANVAS_NOT_FOUND" };
    default: return { status: 403, code: "FORBIDDEN" };
  }
}

/**
 * 解析并校验一次请求的可信身份与资源权限；返回 principal 或稳定拒绝。
 * 未注入认证器时返回 `{ ok: false, code: "provider-unavailable" }`（fail closed）。
 */
export async function authorizeCanvasRequest(input: {
  req: IncomingMessage;
  canvasId: string;
  permission: ResourcePermission;
  authenticate: CanvasRequestAuthenticator | undefined;
  access: CanvasAccessPort;
}): Promise<{ ok: true; principal: PrincipalContext } | { ok: false; decision: Extract<CanvasAccessDecision, { allowed: false }> }> {
  if (!input.authenticate) {
    return { ok: false, decision: { allowed: false, code: "provider-unavailable", message: "画布认证提供者不可用" } };
  }
  let principal: PrincipalContext | null;
  try { principal = await input.authenticate(input.req, "http"); }
  catch { return { ok: false, decision: { allowed: false, code: "provider-unavailable", message: "画布认证提供者不可用" } }; }
  if (!principal) return { ok: false, decision: { allowed: false, code: "unauthenticated", message: "未认证" } };
  const decision = await input.access.authorize({ principal, canvasId: input.canvasId, permission: input.permission });
  return decision.allowed ? { ok: true, principal } : { ok: false, decision };
}

/** 生命周期端口（beginDelete→reserve→finalize→tombstone）；未注入时按能力拒绝。 */
export type CanvasLifecyclePort = {
  reserve(input: { canvasId: string; principal: PrincipalContext; operationId: string }): Promise<{ ok: true; resumed?: boolean } | { ok: false; code: string; message: string }>;
  finalize(input: { canvasId: string; principal: PrincipalContext; operationId: string }): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  tombstone(input: { canvasId: string; principal: PrincipalContext; operationId: string }): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  /**
   * 删除开始：置 `deleting`（任务 5.2）。provider 未实现时返回 `unsupported`，调用方据此决定
   * 是否跳过中间态。
   */
  beginDelete(input: { canvasId: string; principal: PrincipalContext; operationId: string }): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  /**
   * 启动期结算遗留 provisioning 预留（崩溃恢复，任务 11.2 / D1）。未实现时返回 null（跳过）。
   */
  reconcileProvisioning?(input: { exists(canvasId: string): Promise<boolean>; reservedBefore?: string }): Promise<{ finalized: string[]; cleaned: string[]; failed: string[] } | null>;
  /**
   * 取消未完成的预留（内容创建失败的补偿，任务 11.2 / D1）。未实现时返回 null（跳过）。
   */
  cancelReservation?(input: { canvasId: string; principal: PrincipalContext; operationId: string }): Promise<{ ok: boolean } | null>;
};

export function lifecyclePortFromPolicy(policy: () => ResourceLifecyclePolicy | null): CanvasLifecyclePort {
  const ref = (canvasId: string): ResourceRef => ({ kind: "canvas", id: canvasId });
  return {
    async reserve({ canvasId, principal, operationId }) {
      try {
      const current = policy();
      if (!current || (current.ready && !current.ready())) return { ok: false, code: "provider-unavailable", message: "资源生命周期提供者不可用" };
      const result = await current.reserve({ resource: ref(canvasId), principal, operationId });
      return result.ok ? { ok: true, ...(result.resumed ? { resumed: true } : {}) } : { ok: false, code: result.code, message: result.message };
      } catch { return { ok: false, code: "provider-unavailable", message: "资源生命周期提供者不可用" }; }
    },
    async finalize({ canvasId, principal, operationId }) {
      try {
      const current = policy();
      if (!current || (current.ready && !current.ready())) return { ok: false, code: "provider-unavailable", message: "资源生命周期提供者不可用" };
      const result = await current.finalize({ resource: ref(canvasId), principal, operationId });
      return result.ok ? { ok: true } : { ok: false, code: result.code, message: result.message };
      } catch { return { ok: false, code: "provider-unavailable", message: "资源生命周期提供者不可用" }; }
    },
    async tombstone({ canvasId, principal, operationId }) {
      try {
      const current = policy();
      if (!current || (current.ready && !current.ready())) return { ok: false, code: "provider-unavailable", message: "资源生命周期提供者不可用" };
      const result = await current.tombstone({ resource: ref(canvasId), principal, operationId });
      return result.ok ? { ok: true } : { ok: false, code: result.code, message: result.message };
      } catch { return { ok: false, code: "provider-unavailable", message: "资源生命周期提供者不可用" }; }
    },
    async beginDelete({ canvasId, principal, operationId }) {
      try {
      const current = policy();
      if (!current || (current.ready && !current.ready())) return { ok: false, code: "provider-unavailable", message: "资源生命周期提供者不可用" };
      if (!current.beginDelete) return { ok: false, code: "unsupported", message: "生命周期提供者不支持删除中态" };
      const result = await current.beginDelete({ resource: ref(canvasId), principal, operationId });
      return result.ok ? { ok: true } : { ok: false, code: result.code, message: result.message };
      } catch { return { ok: false, code: "provider-unavailable", message: "资源生命周期提供者不可用" }; }
    },
    async reconcileProvisioning({ exists, reservedBefore }) {
      const current = policy();
      if (!current?.reconcileProvisioning) return null;
      return current.reconcileProvisioning({ exists, ...(reservedBefore ? { reservedBefore } : {}) });
    },
    async cancelReservation({ canvasId, principal, operationId }) {
      const current = policy();
      if (!current?.cancelReservation) return null;
      const result = await current.cancelReservation({ resource: ref(canvasId), principal, operationId });
      return { ok: result.ok };
    }
  };
}
