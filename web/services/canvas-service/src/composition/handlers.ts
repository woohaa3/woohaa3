/**
 * Canvas Service composition：HTTP handler 编排
 * （自 `composition.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R07）。
 *
 * 复用既有 API handler；不创建旁路 dispatcher。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createCanvasRequestHandler } from "../api/canvas-api.js";
import { createSnippetRequestHandler } from "../api/snippet-api.js";
import { createNodeHistoryRequestHandler } from "../api/node-history-api.js";
import { createEditCompletionRequestHandler } from "../api/edit-completion-api.js";
import { createTaskActivityRequestHandler } from "../api/task-activity-api.js";
import type { NodeHistoryThumbnailOptions } from "../model-renderer/node-history-thumbnail.js";
import { createRendererClient, type RendererClient } from "../model-renderer/index.js";
import type { CanvasStorageComposition } from "../storage/composition.js";
import type { SnippetComposition } from "../storage/snippet-composition.js";
import type { NodeHistoryComposition } from "../storage/node-history-composition.js";
import type { CanvasRunService } from "../task/run-service.js";
import type { CanvasTaskClient } from "../clients/task-client.js";
import { createThumbnailPort } from "./history-observers.js";
import { isCanvasPath, safePathname, sendJson } from "./deployment.js";
import { authorizeCanvasRequest, httpStatusForCanvasAccess } from "../access/resolve-access.js";

export type ComposedHandlerDeps = {
  recording?: import("@woohaa3/contracts").CanvasRecordingPort;
  env: Record<string, string | undefined>;
  canvasEnabled: boolean;
  unavailableReason: string | null;
  composition: CanvasStorageComposition | null;
  runService: CanvasRunService | null;
  snippets: SnippetComposition | null;
  nodeHistory: NodeHistoryComposition | null;
  filmSetImportService:
    | ReturnType<NonNullable<NonNullable<import("@woohaa3/contracts").CanvasContentRuntime["mcp"]>["createImportService"]>>
    | undefined;
  filmSetConversionService: import("@woohaa3/contracts").FilmSetConversionServicePort | null;
  /** 「转为片场」owner 解析（宿主注入）；省略时生成端按自身边界处理。 */
  filmSetConversionOwnerResolver?: (input: {
    subject?: string;
    cookie?: string;
  }) => import("@woohaa3/contracts").FilmSetConversionOwner | null;
  modelRenderer: RendererClient | null;
  prepareCompositeHistory?: NodeHistoryThumbnailOptions["prepareCompositeHistory"];
  modelMcpHandler: ((req: unknown, res: ServerResponse) => Promise<boolean>) | null;
  modelMcpInternalHandler: ((req: unknown, res: ServerResponse) => Promise<boolean>) | null;
  agentInternalHandler: ((req: unknown, res: ServerResponse) => Promise<boolean>) | null;
  taskClient: CanvasTaskClient | undefined;
  storageServiceToken: string | undefined;
  /** 画布存在性 + ACL 钩子（含 Yjs-only room 回退），由 composition 提供。 */
  canvasExists: (canvasId: string, req?: IncomingMessage) => Promise<boolean>;
  /**
   * 统一入口资源授权（change: 2026-10-13-...，任务 4.4/6.1/6.2/6.5）：注入后 HTTP native 路由按
   * 可信 principal 判定 read/write/delete；缺省保持历史服务令牌/loopback 行为。
   */
  authenticate?: import("../access/resolve-access.js").CanvasRequestAuthenticator;
  accessRuntime?: import("@woohaa3/contracts").AccessRuntime;
  access?: import("../access/resolve-access.js").CanvasAccessPort;
  lifecycle?: import("../access/resolve-access.js").CanvasLifecyclePort | null;
  /** 可信主体的可发现画布 ID 全集（分页前过滤）；未注入时列表逐项判定。 */
  discoverableCanvasIds?: (principal: import("@woohaa3/contracts").PrincipalContext) => Promise<string[] | null>;
  /** 删除后关闭该画布的全部实时会话（任务 5.2）。 */
  closeSessions?: (canvasId: string, reason: string) => void | Promise<void>;
  /**
   * 远端删除端口（宿主按 `canvas-upstream` capability 注入）：属于远端的画布先删远端，
   * 再删本机；不注入时删除只作用于本机（纯本地部署）。
   */
  deleteRemote?: (canvasId: string) => Promise<import("@woohaa3/contracts").CanvasUpstreamDeleteResult>;
  /** 在线迁移 prepare/status/来源目录路由（change: 2026-10-12-add-extension-online-canvas-migration）。 */
  preparationHandler?: ((req: IncomingMessage, res: ServerResponse) => Promise<boolean>) | null;
  /** 在线迁移访问门（GET/WS 未准备、DELETE tombstone）。 */
  importGuard?: import("../api/canvas-api/types.js").CanvasImportGuard;
  log: (event: Record<string, unknown>) => void;
};

/** 组装最终 `handle`（canvas → snippets → editCompletion → nodeHistory → activity → MCP 面）。 */
export function composeRequestHandler(deps: ComposedHandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const { composition, log } = deps;
  const tokenLogger = (event: { event: string; status: number; code?: string }) =>
    log({ event: event.event, status: event.status, ...(event.code ? { code: event.code } : {}) });

  const handler =
    composition === null
      ? async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
          if (!deps.canvasEnabled) return false;
          const pathname = safePathname(req.url);
          if (!isCanvasPath(pathname)) return false;
          sendJson(res, 503, {
            error: "canvas-storage-unavailable",
            code: "NOT_READY",
            message: deps.unavailableReason ?? "画布存储不可用"
          });
          return true;
        }
      : createCanvasRequestHandler({
          get recording() { return deps.recording; },
          service: composition.service,
          ...(composition.catalog ? { catalog: composition.catalog } : {}),
          ...(deps.importGuard ? { importGuard: deps.importGuard } : {}),
          runService: deps.runService ?? undefined,
          filmSetImport: {
            import: (request) =>
              deps.filmSetImportService
                ? deps.filmSetImportService.importContent({ ...request, items: [...request.items] })
                : Promise.resolve({ ok: false as const, code: "unavailable", message: "片场导入未启用" })
          },
          ...(deps.filmSetConversionService
            ? {
                filmSetConversion: {
                  submit: (request) => deps.filmSetConversionService!.submit(request),
                  status: (request) => deps.filmSetConversionService!.status(request),
                  cancel: (request) => deps.filmSetConversionService!.cancel(request),
                  ...(deps.filmSetConversionService.retry
                    ? { retry: (request) => deps.filmSetConversionService!.retry!(request) }
                    : {}),
                  ...(deps.filmSetConversionService.models
                    ? { models: () => deps.filmSetConversionService!.models!() }
                    : {})
                }
              }
            : {}),
          ...(deps.filmSetConversionOwnerResolver ? { filmSetConversionOwnerResolver: deps.filmSetConversionOwnerResolver } : {}),
          serviceToken: deps.storageServiceToken,
          ...(deps.accessRuntime ? { accessRuntime: deps.accessRuntime } : {}),
          ...(deps.authenticate ? { authenticate: deps.authenticate } : {}),
          ...(deps.access ? { access: deps.access } : {}),
          ...(deps.lifecycle ? { lifecycle: deps.lifecycle } : {}),
          ...(deps.discoverableCanvasIds ? { discoverableCanvasIds: deps.discoverableCanvasIds } : {}),
          ...(deps.closeSessions ? { closeSessions: deps.closeSessions } : {}),
          ...(deps.deleteRemote ? { deleteRemote: deps.deleteRemote } : {}),
          logger: tokenLogger,
          readiness: async () => {
            const health = await composition.service.health();
            return health.ok ? { ready: true } : { ready: false, reason: `数据库不可用（${health.backend}）` };
          }
        });

  const snippetHandler = deps.snippets
    ? createSnippetRequestHandler({
        service: deps.snippets.service,
        serviceToken: deps.storageServiceToken,
        logger: tokenLogger
      })
    : null;

  const canvasExists = deps.canvasExists;

  const nodeHistoryHandler = deps.nodeHistory
    ? createNodeHistoryRequestHandler({
        service: deps.nodeHistory.service,
        serviceToken: deps.storageServiceToken,
        canvasExists,
        // 清空历史是写操作：注入认证时按可信 principal 判定 write；未注入沿用本机/服务令牌。
        ...(deps.authenticate
          ? {
              authorizeWrite: async ({ canvasId, req }: { canvasId: string; req: IncomingMessage }) => {
                const decision = await authorizeCanvasRequest({
                  req,
                  canvasId,
                  permission: "write",
                  authenticate: deps.authenticate,
                  access: deps.access ?? { authorize: async () => ({ allowed: false, code: "provider-unavailable", message: "画布授权提供者不可用" }) }
                });
                if (decision.ok) return { ok: true as const };
                const mapped = httpStatusForCanvasAccess(decision.decision);
                return { ok: false as const, status: mapped.status, code: mapped.code, message: decision.decision.message };
              }
            }
          : {}),
        thumbnail: createThumbnailPort(deps.modelRenderer ?? createRendererClient(), deps.nodeHistory.service, deps.prepareCompositeHistory),
        logger: tokenLogger
      })
    : null;

  const editCompletionHandler = deps.nodeHistory
    ? createEditCompletionRequestHandler({
        service: deps.nodeHistory.editCompletion,
        serviceToken: deps.storageServiceToken,
        canvasExists,
        logger: tokenLogger
      })
    : null;

  const taskActivityHandler = createTaskActivityRequestHandler({
    taskClient: () => deps.taskClient,
    serviceToken: deps.storageServiceToken,
    canvasExists,
    logger: tokenLogger
  });

  return async (req, res) => {
    if (deps.preparationHandler && (await deps.preparationHandler(req, res))) return true;
    if (await handler(req, res)) return true;
    if (snippetHandler && (await snippetHandler(req, res))) return true;
    if (editCompletionHandler && (await editCompletionHandler(req, res))) return true;
    if (nodeHistoryHandler && (await nodeHistoryHandler(req, res))) return true;
    if (await taskActivityHandler(req, res)) return true;
    if (deps.modelMcpHandler && (await deps.modelMcpHandler(req, res))) return true;
    if (deps.modelMcpInternalHandler && (await deps.modelMcpInternalHandler(req, res))) return true;
    if (deps.agentInternalHandler && (await deps.agentInternalHandler(req, res))) return true;
    return false;
  };
}
