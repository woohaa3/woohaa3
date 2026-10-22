/**
 * Canvas 服务资源授权端口
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 4.4/6.1/6.2/6.5/6.8 / design D8）。
 *
 * Canvas 服务不再自行判断「画布是否存在即可访问」。宿主（统一后端）把 Access 提供的
 * `ResourceAccessPolicy` 经本端口注入；每个 HTTP/WS/facade 入口按可信 principal.subject 对该
 * canvasId 判定 read/write/manageSharing/delete。未配置该端口时 **fail closed**：不因知道 canvasId
 * 就放行，不退回存在性判定或 loopback 兜底。
 *
 * 本模块只定义端口与判定结果类型，不含 ACL 业务（ACL 权威属 Access 扩展）。
 */
import type { PrincipalContext, ResourcePermission } from "@woohaa3/contracts";

export type CanvasAccessRequest = {
  /** 可信 principal（入口从认证接缝建立；绝不来自请求体）。 */
  principal: PrincipalContext;
  canvasId: string;
  permission: ResourcePermission;
};

export type CanvasAccessDecision =
  | { allowed: true }
  | { allowed: false; code: "unauthenticated" | "forbidden" | "not-found" | "provider-unavailable"; message: string };

/**
 * Canvas 资源授权端口：由统一后端用 `ResourceAccessPolicy` 适配。
 *
 * `authorize` 必须在读取画布/建立 room/提交命令/产生工作**之前**调用。
 */
export interface CanvasAccessPort {
  authorize(input: CanvasAccessRequest): Promise<CanvasAccessDecision>;
}

/**
 * 由返回决策类型资源的策略函数构造端口（宿主适配 ResourceAccessPolicy 用）。
 *
 * 传入的 `authorize` 返回 `{ allowed }` 或 `{ allowed: false, code }`；本函数归一化为稳定的
 * `CanvasAccessDecision`，缺失/故障一律拒绝，不隐式放行。
 */
export function createCanvasAccessPort(
  authorize: (input: CanvasAccessRequest) => Promise<
    | { allowed: true }
    | { allowed: false; code: string; message?: string }
  >
): CanvasAccessPort {
  return {
    async authorize(input) {
      const decision = await authorize(input);
      if (decision.allowed) return { allowed: true };
      const code = decision.code;
      const normalized: Exclude<CanvasAccessDecision, { allowed: true }>["code"] =
        code === "unauthenticated"
          ? "unauthenticated"
          : code === "forbidden"
            ? "forbidden"
            : code === "not-found"
              ? "not-found"
              : code === "provider-unavailable"
                ? "provider-unavailable"
                : "forbidden";
      return { allowed: false, code: normalized, message: decision.message ?? "无权访问该画布" };
    }
  };
}

/** 未配置授权端口：一律拒绝（fail closed，绝不因存在性放行）。 */
export function denyingCanvasAccessPort(): CanvasAccessPort {
  return {
    async authorize() {
      return { allowed: false, code: "provider-unavailable", message: "画布授权提供者不可用" };
    }
  };
}
