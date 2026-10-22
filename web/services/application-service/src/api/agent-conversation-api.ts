/**
 * 宿主 Agent 会话公共 API 分派
 * （change: 2026-10-12-add-agent-conversation-panel，任务 1.6 / design D2）。
 *
 * 同源路径 `/api/agent-conversations/*`，由 Application Service 承载：
 * ```
 * GET  /api/agent-conversations/catalog?adapterId=            账户目录/授权/能力（owner 隔离）
 * GET  /api/agent-conversations/mcp                            内置 MCP 真实发现 + 外部连接指引
 * POST /api/agent-conversations/conversations                创建会话
 * GET  /api/agent-conversations/conversations?canvasId=&limit= 列出会话
 * GET  /api/agent-conversations/conversations/:id?cursor=     会话快照（消息/回合/事件）
 * POST /api/agent-conversations/conversations/:id/turns       接受并异步执行回合
 * GET  /api/agent-conversations/target?canvasId=&nodeId=      该节点当前会话（一个节点复用一条）
 * POST /api/agent-conversations/context/clear                 清空节点上下文（归档旧会话）
 * GET  /api/agent-conversations/turns/:requestId              查询确切回合（不重新 dispatch）
 * POST /api/agent-conversations/turns/:requestId/cancel       取消在途回合
 * POST /api/agent-conversations/turns/:requestId/link         由领域链显式关联 run/task
 * ```
 *
 * owner 只来自同一 Identity provider 建立的可信 principal，绝不接受请求 body 自报；每个画布操作在
 * 进入会话存储前经 canvasAccess 授权。打开/关闭/查询只读，不创建新执行。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AGENT_CONVERSATION_BASE_PATH,
  resolveRequestDataContext,
  addAppBasePath,
  WOOHAA3_PROTOCOL_VERSION,
  decodeAcceptTurnRequest,
  decodeCanvasCreationRequest,
  decodeClearContextRequest,
  decodeCreateConversationRequest,
  decodeCursorQuery,
  decodeLinkRunRequest,
  decodeSwitchConnectionRequest,
  type ApplicationExtensionCanvasAccessFacade
} from "@woohaa3/contracts";
import type { ApplicationRequestAuthenticator } from "../auth/adapter.js";
import { sendError, sendJson, readJson, safeUrl } from "./extension-api/http-helpers.js";
import type { AgentConversationService, AgentConversationServiceError } from "../extensions/agent-conversation-service.js";
import type { AgentConnectionRegistry } from "../extensions/agent-connection-registry.js";

export type AgentConversationApiDependencies = {
  canvasCreations?: import("../extensions/canvas-creation-service.js").CanvasCreationService;
  accessRuntime?: import("@woohaa3/contracts").AccessRuntime;
  service: AgentConversationService;
  authenticator?: ApplicationRequestAuthenticator;
  /** 受控项目读写授权（owner+canvas 隔离）；缺失时拒绝（fail closed）。 */
  canvasAccess?: ApplicationExtensionCanvasAccessFacade;
  /**
   * 来源连接发现（change: 2026-10-16-...，任务 2.1/2.3）。缺失时 `GET /connections` 返回空。
   */
  connections?: AgentConnectionRegistry;

  /**
   * 内置 MCP 真实发现（change: 2026-10-12-add-agent-conversation-panel，任务 3.1/3.2）。
   *
   * 宿主注入后端 executed initialize/tools/list 结果；缺失时 `GET /mcp` 返回 not-configured，
   * 绝不伪造 ready。外部连接指引由 handler 用请求 origin 派生。
   */
  mcpDiscovery?: () => Promise<import("@woohaa3/contracts").McpBuiltinDiscoveryView>;
  /** 当前公开挂载路径；外部 MCP 指引 URL 在其上派生（change: 2026-10-15-...）。 */
  basePath?: string;
  maxRequestBytes?: number;
  logger?: (event: Record<string, unknown>) => void;
};

export type AgentConversationApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

const STATUS_FOR: Record<AgentConversationServiceError["code"], number> = {
  "malformed-request": 400,
  unauthorized: 401,
  "not-found": 404,
  "request-id-reused": 409,
  "conversation-busy": 409,
  "adapter-unavailable": 503,
  "connection-unavailable": 409,
  "capability-unsupported": 400,
  "budget-exceeded": 429,
  "storage-failed": 500
};

export function createAgentConversationApiHandler(deps: AgentConversationApiDependencies): AgentConversationApiHandler {
  const log = deps.logger ?? (() => undefined);
  const maxBytes = deps.maxRequestBytes ?? 256 * 1024;

  return async (req, res) => {
    const url = safeUrl(req.url);
    if (!url) return false;
    const pathname = url.pathname;
    if (pathname !== AGENT_CONVERSATION_BASE_PATH && !pathname.startsWith(`${AGENT_CONVERSATION_BASE_PATH}/`)) return false;
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return true;
    }

    let principal: Awaited<ReturnType<ApplicationRequestAuthenticator>>;
    try {
      principal = deps.accessRuntime?.enabled === false ? null : await deps.authenticator?.(req, "http") ?? null;
    } catch {
      sendJson(res, 503, { code: "access-provider-unavailable", message: "身份提供者不可用", protocolVersion: WOOHAA3_PROTOCOL_VERSION });
      return true;
    }
    if (!principal && deps.accessRuntime?.enabled !== false) {
      sendError(res, 401, "unauthorized", "需要已认证用户");
      return true;
    }

    const owner = resolveRequestDataContext(deps.accessRuntime ?? { enabled: true }, principal).dataScope.ownerId;
    const suffix = pathname.slice(AGENT_CONVERSATION_BASE_PATH.length).replace(/^\/+/, "");
    const method = req.method ?? "GET";

    try {
      if (suffix === "canvas-creations" && method === "GET") {
        const canvasId = url.searchParams.get("canvasId") ?? "";
        const allowed = await authorizeCanvas(deps, owner, canvasId, "read");
        if (!allowed.ok) return respondError(res, allowed.error);
        sendJson(res, 200, { creations: await deps.canvasCreations?.list(owner, canvasId) ?? [] });
        return true;
      }
      if (suffix === "canvas-creations" && method === "POST") {
        const decoded = decodeCanvasCreationRequest(await readJson(req, maxBytes));
        if (!decoded.ok) return badRequest(res, decoded.message);
        const allowed = await authorizeCanvas(deps, owner, decoded.value.canvasId, "write");
        if (!allowed.ok) return respondError(res, allowed.error);
        if (!deps.canvasCreations) return badRequest(res, "组创作服务未装配");
        try { sendJson(res, 200, { creation: await deps.canvasCreations.accept(owner, decoded.value) }); }
        catch (e) { const error = e as { code?: string; message?: string }; sendJson(res, error.code === "unauthorized" ? 403 : error.code === "request-id-reused" ? 409 : 400, { code: error.code ?? "creation-failed", message: error.message ?? "创建失败", creationRegistered: Boolean(deps.canvasCreations.peek(owner, decoded.value.requestId)) }); }
        return true;
      }
      const creationRetry = /^canvas-creations\/([^/]+)\/retry$/.exec(suffix);
      if (creationRetry && method === "POST") {
        const requestId = decodeURIComponent(creationRetry[1]!);
        const known = deps.canvasCreations?.peek(owner, requestId);
        if (!known) return respondError(res, { code: "not-found", message: "创建请求不存在" });
        const allowed = await authorizeCanvas(deps, owner, known.canvasId, "write");
        if (!allowed.ok) return respondError(res, allowed.error);
        try { sendJson(res, 200, { creation: await deps.canvasCreations!.retry(owner, requestId) }); }
        catch (e) {
          const error = e as { code?: string; message?: string };
          sendJson(res, error.code === "unauthorized" ? 403 : error.code === "request-id-reused" ? 409 : 400, { code: error.code ?? "creation-failed", message: error.message ?? "创建失败", creationRegistered: true });
        }
        return true;
      }
      const creationRead = /^canvas-creations\/([^/]+)$/.exec(suffix);
      if (creationRead && method === "GET") {
        const requestId = decodeURIComponent(creationRead[1]!);
        const known = deps.canvasCreations?.peek(owner, requestId);
        if (!known) return respondError(res, { code: "not-found", message: "创建请求不存在" });
        const allowed = await authorizeCanvas(deps, owner, known.canvasId, "read");
        if (!allowed.ok) return respondError(res, allowed.error);
        const creation = await deps.canvasCreations!.query(owner, requestId);
        sendJson(res, 200, { creation });
        return true;
      }
      // GET /catalog
      if (suffix === "catalog" && method === "GET") {
        const adapterId = url.searchParams.get("adapterId") ?? undefined;
        const result = await deps.service.catalog({ owner, ...(adapterId ? { adapterId } : {}) });
        if (!result.ok) return respondError(res, result.error);
        sendJson(res, 200, result);
        return true;
      }

      // GET /connections：该 owner 可见的来源连接（不含秘密；change: 2026-10-16-...，任务 2.1）。
      if (suffix === "connections" && method === "GET") {
        if (!deps.connections) {
          sendJson(res, 200, { connections: [] });
          return true;
        }
        const adapterId = url.searchParams.get("adapterId") ?? undefined;
        const list = await deps.connections.listConnections({ owner, ...(adapterId ? { adapterId } : {}) });
        sendJson(res, 200, { connections: list });
        return true;
      }

      // GET /mcp：内置真实发现 + 外部连接指引（仅外部客户端自身心跳才表示已连接）。
      if (suffix === "mcp" && method === "GET") {
        const builtin = deps.mcpDiscovery
          ? await deps.mcpDiscovery()
          : { ready: false, status: "not-configured" as const, tools: [], reason: "内置 MCP 发现未配置", checkedAt: new Date().toISOString() };
        sendJson(res, 200, {
          builtin,
          external: { serverUrl: externalMcpUrl(req, deps.basePath ?? "/"), transport: "streamable-http" }
        });
        return true;
      }

      // /conversations
      if (suffix === "conversations" && method === "POST") {
        const body = await readJson(req, maxBytes);
        if (body === null) return badRequest(res, "请求体非法");
        const decoded = decodeCreateConversationRequest(body);
        if (!decoded.ok) return badRequest(res, decoded.message, decoded.code);
        const allowed = await authorizeCanvas(deps, owner, decoded.value.canvasId, "write");
        if (!allowed.ok) return respondError(res, allowed.error);
        const result = deps.service.createConversation({ owner, canvasId: decoded.value.canvasId, ...(decoded.value.adapterId ? { adapterId: decoded.value.adapterId } : {}), ...(decoded.value.title ? { title: decoded.value.title } : {}), ...(decoded.value.nodeId ? { nodeId: decoded.value.nodeId } : {}), ...(decoded.value.connectionId ? { connectionId: decoded.value.connectionId } : {}) });
        if (!result.ok) return respondError(res, result.error);
        sendJson(res, 200, { conversation: result.conversation });
        return true;
      }
      if (suffix === "conversations" && method === "GET") {
        const canvasId = url.searchParams.get("canvasId") ?? "";
        if (canvasId === "") return badRequest(res, "缺少 canvasId");
        const allowed = await authorizeCanvas(deps, owner, canvasId, "read");
        if (!allowed.ok) return respondError(res, allowed.error);
        const limit = Number(url.searchParams.get("limit") ?? "50");
        sendJson(res, 200, { conversations: deps.service.listConversations({ owner, canvasId, limit: Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 200) : 50 }) });
        return true;
      }

      // GET /target?canvasId=&nodeId=&connectionId=：该节点当前会话（一个节点复用一条；design D8）。
      if (suffix === "target" && method === "GET") {
        const canvasId = url.searchParams.get("canvasId") ?? "";
        const nodeId = url.searchParams.get("nodeId") ?? "";
        if (canvasId === "" || nodeId === "") return badRequest(res, "缺少 canvasId 或 nodeId");
        const allowed = await authorizeCanvas(deps, owner, canvasId, "read");
        if (!allowed.ok) return respondError(res, allowed.error);
        const connectionId = url.searchParams.get("connectionId") ?? undefined;
        const result = deps.service.findConversationForTarget({ owner, canvasId, nodeId, ...(connectionId ? { connectionId } : {}) });
        sendJson(res, 200, { conversation: result.conversation });
        return true;
      }

      // POST /context/clear：清空节点上下文（解除关联、归档旧会话，不删除历史；design D8）。
      if (suffix === "context/clear" && method === "POST") {
        const body = await readJson(req, maxBytes);
        if (body === null) return badRequest(res, "请求体非法");
        const decoded = decodeClearContextRequest(body);
        if (!decoded.ok) return badRequest(res, decoded.message, decoded.code);
        const allowed = await authorizeCanvas(deps, owner, decoded.value.canvasId, "write");
        if (!allowed.ok) return respondError(res, allowed.error);
        const result = deps.service.clearContext({ owner, canvasId: decoded.value.canvasId, nodeId: decoded.value.nodeId });
        if (!result.ok) return respondError(res, result.error);
        sendJson(res, 200, { ok: true, cleared: result.cleared });
        return true;
      }

      // POST /context/switch：显式切换来源连接（归档旧会话，保留历史；change: 2026-10-16-...，任务 2.3）。
      if (suffix === "context/switch" && method === "POST") {
        const body = await readJson(req, maxBytes);
        if (body === null) return badRequest(res, "请求体非法");
        const decoded = decodeSwitchConnectionRequest(body);
        if (!decoded.ok) return badRequest(res, decoded.message, decoded.code);
        const allowed = await authorizeCanvas(deps, owner, decoded.value.canvasId, "write");
        if (!allowed.ok) return respondError(res, allowed.error);
        const result = await deps.service.switchConnection({ owner, canvasId: decoded.value.canvasId, nodeId: decoded.value.nodeId, connectionId: decoded.value.connectionId });
        if (!result.ok) return respondError(res, result.error);
        sendJson(res, 200, { ok: true, cleared: result.cleared });
        return true;
      }

      const conversationRead = /^conversations\/([^/]+)$/.exec(suffix);
      if (conversationRead && method === "GET") {
        const conversationId = decodeURIComponent(conversationRead[1]!);
        const cursor = decodeCursorQuery(url.searchParams.get("cursor"));
        const result = deps.service.readConversation({ owner, conversationId, cursor });
        if (!result.ok) return respondError(res, result.error);
        const canvasAllowed = await authorizeCanvas(deps, owner, result.snapshot.conversation.canvasId, "read");
        if (!canvasAllowed.ok) return respondError(res, canvasAllowed.error);
        sendJson(res, 200, result.snapshot);
        return true;
      }

      const turnsCreate = /^conversations\/([^/]+)\/turns$/.exec(suffix);
      if (turnsCreate && method === "POST") {
        const conversationId = decodeURIComponent(turnsCreate[1]!);
        const body = await readJson(req, maxBytes);
        if (body === null) return badRequest(res, "请求体非法");
        const decoded = decodeAcceptTurnRequest(body);
        if (!decoded.ok) return badRequest(res, decoded.message, decoded.code);
        const read = deps.service.readConversation({ owner, conversationId });
        if (!read.ok) return respondError(res, read.error);
        const canvasId = read.snapshot.conversation.canvasId;
        const adapterId = read.snapshot.conversation.adapterId;
        const permission = decoded.value.entry.action === "discuss" ? "read" : "write";
        const allowed = await authorizeCanvas(deps, owner, canvasId, permission);
        if (!allowed.ok) return respondError(res, allowed.error);
        if (decoded.value.entry.canvasId !== canvasId) return respondError(res, { code: "unauthorized", message: "目标画布与会话不一致" });
        // 冻结本回合连接身份：显式选择校验归属，缺失时映射兼容默认连接（change: 2026-10-16-...，任务 2.2）。
        const connection = await deps.service.resolveConnectionBinding({ owner, adapterId, ...(decoded.value.entry.connectionId ? { connectionId: decoded.value.entry.connectionId } : {}) });
        if (!connection.ok) return respondError(res, connection.error);
        const frozen = decoded.value.entry.connection;
        if (frozen && (!connection.binding || frozen.connectionId !== connection.binding.connectionId || frozen.adapterId !== connection.binding.adapterId || frozen.configRevision !== connection.binding.configRevision || frozen.credentialEpoch !== connection.binding.credentialEpoch)) return respondError(res, { code: "connection-unavailable", message: "助手连接版本已变更，请重新选择" });
        // A version upgrade may archive the old target while resolving the binding.
        // Only that transition creates a fresh conversation; archived history stays immutable.
        let acceptedConversationId = conversationId;
        if (decoded.value.entry.action !== "discuss" && read.snapshot.conversation.nodeId) {
          const current = deps.service.readConversation({ owner, conversationId });
          if (!current.ok) return respondError(res, current.error);
          if (!current.snapshot.conversation.nodeId) {
            const fresh = deps.service.createConversation({ owner, canvasId, adapterId, nodeId: read.snapshot.conversation.nodeId, ...(connection.binding ? { connectionId: connection.binding.connectionId } : {}) });
            if (!fresh.ok) return respondError(res, fresh.error);
            acceptedConversationId = fresh.conversation.conversationId;
          }
        }
        const accepted = deps.service.acceptTurn({ owner, conversationId: acceptedConversationId, requestId: decoded.value.requestId, entry: decoded.value.entry, connection: connection.binding });
        if (!accepted.ok) return respondError(res, accepted.error);
        if (!accepted.reused) void deps.service.dispatchTurn(accepted.turn.turnId);
        sendJson(res, 200, { conversation: accepted.conversation, turn: accepted.turn, reused: accepted.reused });
        return true;
      }

      const turnQuery = /^turns\/([^/]+)$/.exec(suffix);
      if (turnQuery && method === "GET") {
        const requestId = decodeURIComponent(turnQuery[1]!);
        const result = deps.service.queryTurn({ owner, requestId });
        if (!result.ok) return respondError(res, result.error);
        sendJson(res, 200, result);
        return true;
      }

      // 活动/历史 Agent 记录 → 按领域运行关联定位确切回合（只读，不按 nodeId 取最近会话）。
      if (suffix === "locate" && method === "GET") {
        const runId = url.searchParams.get("runId") ?? "";
        if (runId === "") return badRequest(res, "缺少 runId");
        const result = deps.service.locateTurnByRun({ owner, runId });
        if (!result.ok) return respondError(res, result.error);
        const canvasAllowed = await authorizeCanvas(deps, owner, result.snapshot.conversation.canvasId, "read");
        if (!canvasAllowed.ok) return respondError(res, canvasAllowed.error);
        sendJson(res, 200, result);
        return true;
      }

      const turnCancel = /^turns\/([^/]+)\/cancel$/.exec(suffix);
      if (turnCancel && method === "POST") {
        const requestId = decodeURIComponent(turnCancel[1]!);
        const result = deps.service.cancelTurn({ owner, requestId });
        if (!result.ok) return respondError(res, result.error);
        sendJson(res, 200, { ok: true });
        return true;
      }

      const turnLink = /^turns\/([^/]+)\/link$/.exec(suffix);
      if (turnLink && method === "POST") {
        const requestId = decodeURIComponent(turnLink[1]!);
        const body = await readJson(req, maxBytes);
        if (body === null) return badRequest(res, "请求体非法");
        const decoded = decodeLinkRunRequest(body);
        if (!decoded.ok) return badRequest(res, decoded.message, decoded.code);
        const result = deps.service.linkRun({ owner, requestId, ...(decoded.value.runId ? { runId: decoded.value.runId } : {}), ...(decoded.value.taskId ? { taskId: decoded.value.taskId } : {}) });
        if (!result.ok) return respondError(res, result.error);
        sendJson(res, 200, { turn: result.turn });
        return true;
      }

      sendError(res, 404, "extension-not-found", "未知的会话路由");
      return true;
    } catch (error) {
      log({ event: "agent-conversation-api-error", message: error instanceof Error ? error.message : String(error), path: suffix });
      sendError(res, 500, "storage-failed", "会话服务暂时不可用");
      return true;
    }
  };
}

async function authorizeCanvas(
  deps: AgentConversationApiDependencies,
  owner: string,
  canvasId: string,
  permission: "read" | "write"
): Promise<{ ok: true } | { ok: false; error: AgentConversationServiceError }> {
  if (!deps.canvasAccess) return { ok: false, error: { code: "unauthorized", message: "画布授权未配置" } };
  const result = await deps.canvasAccess.authorize({ subject: owner, canvasId, permission });
  if (!result.ok) return { ok: false, error: { code: result.code === "unavailable" ? "adapter-unavailable" : "unauthorized", message: result.message } };
  return { ok: true };
}

function respondError(res: ServerResponse, error: AgentConversationServiceError): true {
  sendError(res, STATUS_FOR[error.code] ?? 400, error.code === "not-found" ? "extension-not-found" : error.code === "unauthorized" ? "unauthorized" : "malformed-request", error.message);
  return true;
}

function badRequest(res: ServerResponse, message: string, code = "malformed-request"): true {
  sendError(res, 400, code === "malformed-request" ? "malformed-request" : "malformed-request", message);
  return true;
}

/**
 * 外部连接指引的当前 origin 绝对 URL（Streamable HTTP）
 * （change: 2026-10-12-add-agent-conversation-panel，任务 3.6 / design D4）。
 *
 * 只派生 URL，不探测外部客户端是否在线；复制地址不等于外部已连接。
 */
function externalMcpUrl(req: IncomingMessage, basePath: string): string {
  const forwardedHost = firstHeader(req.headers["x-forwarded-host"]);
  const host = forwardedHost ?? req.headers.host ?? "localhost";
  const forwardedProto = firstHeader(req.headers["x-forwarded-proto"]);
  const secure = forwardedProto === "https" || forwardedProto === "wss";
  return `${secure ? "https" : "http"}://${host}${addAppBasePath(basePath, "/mcp/model-canvas")}`;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed === "" ? undefined : trimmed;
}
