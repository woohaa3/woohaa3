/**
 * Canvas 服务：把「在线迁移导入目标 ACL」（`canvas_imported_access`）并入统一 `CanvasAccessPort`
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 5.9 / design D8）。
 *
 * 背景：在线迁移的导入目标带**第二套** ACL（`canvas_imported_access`），此前只在 Canvas HTTP
 * 路由的导入分支被判定，WS 命令复核、Agent/MCP authorizer、生命周期前置判定都只看企业
 * `ResourceAccessPolicy`——导入画布在那些入口会被一律拒绝。本模块把导入 ACL 作为**同一端口**的
 * 前置判定：
 *   - 目标是导入画布（导入 ACL 有该 canvasId）→ 由导入 ACL 决定，**不**回退企业策略
 *     （「不覆盖当前 ACL」：导入 ACL 对导入目标是权威）；
 *   - 目标不是导入画布（resolver 返回 `null`）→ 交回企业 `ResourceAccessPolicy`。
 *
 * 解析器故障按 fail closed（`provider-unavailable`），绝不因「查不到导入 ACL」而放行。
 */
import type { ResourcePermission } from "@woohaa3/contracts";
import type { CanvasAccessDecision, CanvasAccessPort } from "./access-port.js";

export type ImportedCanvasAccessQuery = {
  canvasId: string;
  subject: string;
  permission: ResourcePermission;
};

/** 返回 `null` 表示目标**不是**导入画布（交回企业策略）；`false` 表示导入目标但无权。 */
export type ImportedCanvasAccessResolver = (query: ImportedCanvasAccessQuery) => boolean | null;

/**
 * 导入 ACL 只区分 read/write：`manageSharing`/`delete` 归一到 write（导入目标的 owner 即有写权限
 * 与删除权；与 `canWriteImported` 的语义一致）。
 */
export function importedPermissionFor(permission: ResourcePermission): "read" | "write" {
  return permission === "read" ? "read" : "write";
}

export function composeImportedFirstCanvasAccess(input: {
  imported: () => ImportedCanvasAccessResolver | null;
  fallback: CanvasAccessPort;
}): CanvasAccessPort {
  return {
    async authorize(request): Promise<CanvasAccessDecision> {
      const resolver = input.imported();
      if (resolver) {
        let decision: boolean | null;
        try {
          decision = resolver({
            canvasId: request.canvasId,
            subject: request.principal.subject,
            permission: request.permission
          });
        } catch {
          return { allowed: false, code: "provider-unavailable", message: "画布授权提供者不可用" };
        }
        if (decision !== null) {
          return decision
            ? { allowed: true }
            : { allowed: false, code: "forbidden", message: "无权访问该作品" };
        }
      }
      return input.fallback.authorize(request);
    }
  };
}
