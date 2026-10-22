/**
 * Canvas 服务：把宿主注入的 `CanvasAccessPort`/`ResourceDirectory` 适配为 Agent 授权/目录端口
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 4.4/6.5 / design D8）。
 *
 * 替换旧的「存在性判定」`createStorageBackedAuthorizer`：MCP Service、extension `canvasAccess`/
 * `extensionNodes` 与 run 系列路由的每个读写都用与 HTTP/WS **同一个** `ResourceAccessPolicy`
 * 决策；未提供/故障时 fail closed——绝不因知道 canvasId 就放行，也不退回「列出全库画布」。
 */
import type { PrincipalContext, ResourceDirectory } from "@woohaa3/contracts";
import type { CanvasAuthorizationResult, CanvasAuthorizer, CanvasDirectory, CanvasListPage } from "../agent-authoring/authorization.js";
import type { CanvasAccessPort } from "./access-port.js";

/** 内部协议注入的 delegated principal 的 identityProvider（与 extension-mcp 一致）。 */
export const AGENT_DELEGATED_IDENTITY_PROVIDER = "mcp-delegation";

/** delegated principalId → 可信 principal 上下文；空 subject 由调用方拒绝（匿名）。 */
export function delegatedPrincipalContext(principalId: string): PrincipalContext {
  return { subject: principalId, identityProvider: AGENT_DELEGATED_IDENTITY_PROVIDER };
}

/**
 * 由资源授权端口构造 Agent authorizer：每次调用都重新查询策略（支持在线更新 ACL），
 * 决策来自 Access 的 `ResourceAccessPolicy`。
 */
export function createPolicyBackedAuthorizer(access: CanvasAccessPort): CanvasAuthorizer {
  return {
    async authorize({ principalId, canvasId, permission }): Promise<CanvasAuthorizationResult> {
      const subject = principalId.trim();
      if (subject === "") return { allowed: false, reason: "缺少已认证 principal" };
      try {
        const decision = await access.authorize({ principal: delegatedPrincipalContext(subject), canvasId, permission });
        return decision.allowed ? { allowed: true } : { allowed: false, reason: decision.message };
      } catch {
        return { allowed: false, reason: "资源授权提供者不可用" };
      }
    }
  };
}

/** 翻页收集可发现 ID 时使用的目录页大小（与目录自身上限一致）。 */
export const DISCOVERABLE_CANVAS_IDS_PAGE_LIMIT = 100;

/**
 * 由资源目录提供者构造「可信主体的画布**可发现集合** ID 全集」（change: 2026-10-13-...，任务 5.5）。
 *
 * 同源画布列表据此在**分页之前**过滤，与「我的目录」/Agent 目录同一发现规则：仅本人创建/
 * 指定协作及登记的无属主 legacy，everyone 链接可读集合不进发现列表。优先用
 * `listDiscoverableIds`（一次全量）；未实现时翻页收集 `list` 条目。
 *
 * 返回 `null` 表示目录提供者未注入（调用方回退逐项判定）；抛出表示提供者故障
 * （调用方 fail closed，绝不退回列出全库）。
 */
export function createDiscoverableCanvasIds(
  directory: () => ResourceDirectory | null
): (principal: PrincipalContext) => Promise<string[] | null> {
  return async (principal) => {
    const provider = directory();
    if (!provider) return null;
    if (principal.subject.trim() === "") return [];
    if (provider.listDiscoverableIds) {
      const ids = await provider.listDiscoverableIds({ principal });
      return ids.filter((id) => typeof id === "string" && id !== "");
    }
    const ids: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await provider.list({
        principal,
        limit: DISCOVERABLE_CANVAS_IDS_PAGE_LIMIT,
        ...(cursor ? { cursor } : {})
      });
      for (const item of page.items) if (item.resource.kind === "canvas") ids.push(item.resource.id);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return ids;
  };
}

/**
 * 合并「我的目录」可发现集合与在线迁移导入目标的可读集合（change: 2026-10-13-...，任务 5.9）。
 *
 * 导入目标的权威 ACL 是 `canvas_imported_access`（独立于企业 ACL），不会出现在 `ResourceDirectory`
 * 的发现规则里；若不并集，导入画布在「我的目录」/Canvas 切换器中永远不可见。语义：
 *   - `enterprise === null`（目录提供者未注入）→ 返回 `null`，调用方保持逐项回退，不伪造完整集合；
 *   - 否则返回并集（去重），由仓库按 `updatedAt`/稳定 canvasId 排序、分页与计算 total。
 */
export function mergeDiscoverableIds(enterprise: string[] | null, imported: readonly string[]): string[] | null {
  if (enterprise === null) return null;
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const id of enterprise) {
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
  }
  for (const id of imported) {
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
  }
  return merged;
}

/**
 * 由资源目录提供者构造 Agent 目录（与「我的目录」同一发现规则）。
 * 目录未注入或故障时返回空列表（fail closed），不退回存储全量列举。
 */
export function createPolicyBackedDirectory(directory: () => ResourceDirectory | null): CanvasDirectory {
  return {
    async list({ principalId, cursor, limit }): Promise<CanvasListPage> {
      const subject = principalId.trim();
      if (subject === "") return { canvases: [] };
      const provider = directory();
      if (!provider) return { canvases: [] };
      try {
        const page = await provider.list({
          principal: delegatedPrincipalContext(subject),
          ...(cursor !== undefined ? { cursor } : {}),
          ...(limit !== undefined ? { limit } : {})
        });
        return {
          canvases: page.items
            .filter((item) => item.resource.kind === "canvas")
            .map((item) => ({
              canvasId: item.resource.id,
              title: item.title,
              revision: item.revision,
              updatedAt: item.updatedAt,
              nodeCount: item.nodeCount
            })),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
        };
      } catch {
        return { canvases: [] };
      }
    }
  };
}

/** 合并策略目录与导入画布目录；两者保留各自的权威 ACL。 */
export function createCombinedDiscoverableCanvasIds(
  policyDirectory: (principal: PrincipalContext) => Promise<string[] | null>,
  importedIds: (subject: string) => readonly string[]
) {
  return async (principal: PrincipalContext): Promise<string[] | null> =>
    mergeDiscoverableIds(await policyDirectory(principal), [...importedIds(principal.subject)]);
}
