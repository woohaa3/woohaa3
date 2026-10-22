/**
 * Canvas 侧 Agent 授权与画布列举端口
 * （change: add-agent-canvas-authoring-mcp，任务 2.3 / design D11）。
 *
 * 多用户生产环境下，MCP Service 以服务令牌调用 Canvas，并在内部 envelope 中携带**经认证的
 * delegated principalId**；Canvas 侧据此判定该 principal 对 canvas 的读写权限。
 *
 * 本模块只提供**端口与默认实现**：
 * - `CanvasAuthorizer`：判定 principal 对 canvasId 的读/写权限；
 * - `CanvasDirectory`：按 principal 稳定列出可访问画布（cursor 分页）。
 *
 * 默认 loopback 开发实现从进程级配置读取允许的画布集合；生产实现（接 IAM）由部署注入，
 * MCP Service 不感知具体存储。授权判定必须在读取节点/生成计划/产生写入**之前**完成。
 */
import type { ServerCanvas } from "@woohaa3/contracts";

export type CanvasPermission = "read" | "write";

export type CanvasAuthorizationResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export type CanvasListItem = {
  canvasId: string;
  title: string;
  revision: number;
  updatedAt: string;
  nodeCount: number;
};

export type CanvasListPage = {
  canvases: CanvasListItem[];
  nextCursor?: string;
};

export interface CanvasAuthorizer {
  authorize(input: { principalId: string; canvasId: string; permission: CanvasPermission }): Promise<CanvasAuthorizationResult>;
}

export interface CanvasDirectory {
  list(input: { principalId: string; cursor?: string; limit?: number }): Promise<CanvasListPage>;
}

/**
 * Loopback 开发授权：允许显式配置的 development principal 访问显式配置的画布集合。
 *
 * **不得**在非 loopback 或生产模式启用；也绝不把未知 canvasId 静默放行（避免进程级默认
 * 画布演变成越权入口）。默认拒绝任何未列出的 canvasId。
 */
export function createDevelopmentAuthorizer(options: {
  developmentPrincipalId: string;
  canvasIds: readonly string[];
}): CanvasAuthorizer {
  const allowed = new Set(options.canvasIds);
  return {
    async authorize({ principalId, canvasId, permission }) {
      if (principalId !== options.developmentPrincipalId) {
        return { allowed: false, reason: "principal 不在开发白名单" };
      }
      if (!allowed.has(canvasId)) {
        return { allowed: false, reason: `画布 ${canvasId} 不在开发白名单` };
      }
      void permission;
      return { allowed: true };
    }
  };
}

/**
 * 由 `CanvasApplicationService` 派生目录/授权的便捷适配。
 *
 * loopback 开发模式下，principal 可访问的画布即存储中的全部画布；未配置 development
 * principal（生产）时，目录返回空、授权拒绝——生产必须经 ingress 注入认证 principal。
 */
export function createStorageBackedAuthorizer(options: {
  developmentPrincipalId?: string;
  listCanvases: (input: { offset?: number; limit?: number }) => Promise<{
    items: Array<{ id: string; title: string; revision: number; updatedAt: string; nodeCount: number }>;
    total: number;
  }>;
  getCanvas: (canvasId: string) => Promise<ServerCanvas>;
}): CanvasAuthorizer & CanvasDirectory {
  const developmentPrincipalId = options.developmentPrincipalId;
  return {
    async authorize({ principalId, canvasId }) {
      if (developmentPrincipalId !== undefined && principalId !== developmentPrincipalId) {
        return { allowed: false, reason: "principal 不在开发白名单" };
      }
      try {
        await options.getCanvas(canvasId);
        return { allowed: true };
      } catch {
        return { allowed: false, reason: `画布 ${canvasId} 不可访问` };
      }
    },
    async list({ principalId, cursor, limit }) {
      if (developmentPrincipalId !== undefined && principalId !== developmentPrincipalId) {
        return { canvases: [] };
      }
      const offset = cursor ? Number(cursor) : 0;
      const pageSize = limit ?? 20;
      const result = await options.listCanvases({ offset: Number.isInteger(offset) ? offset : 0, limit: pageSize });
      const canvases = result.items.map((item) => ({
        canvasId: item.id,
        title: item.title,
        revision: item.revision,
        updatedAt: item.updatedAt,
        nodeCount: item.nodeCount
      }));
      const next = (Number.isInteger(offset) ? offset : 0) + canvases.length;
      return {
        canvases,
        ...(next < result.total ? { nextCursor: String(next) } : {})
      };
    }
  };
}
