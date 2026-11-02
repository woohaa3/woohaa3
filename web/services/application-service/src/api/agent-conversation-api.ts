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
  APPLICATION_EXTENSION_LOAD_ACTION,
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
import type { SkillMediaService } from "../skill-media/service.js";

export type AgentConversationApiDependencies = {
  assistantText?: import("../extensions/assistant-text-service.js").AssistantTextService;
  canvasCreations?: import("../extensions/canvas-creation-service.js").CanvasCreationService;
  accessRuntime?: import("@woohaa3/contracts").AccessRuntime;
  service: AgentConversationService;
  /** Skill 媒体步骤续接（change: 2026-10-28-add-agent-skill-media-regeneration）。 */
  skillMedia?: SkillMediaService;
  authenticator?: ApplicationRequestAuthenticator;
  /** 受控项目读写授权（owner+canvas 隔离）；缺失时拒绝（fail closed）。 */
  canvasAccess?: ApplicationExtensionCanvasAccessFacade;
  /**
   * 来源连接发现（change: 2026-10-16-...，任务 2.1/2.3）。缺失时 `GET /connections` 返回空。
   */
  connections?: AgentConnectionRegistry;
  accessEnforcer?: import("../extensions/access-enforcement.js").AccessEnforcer;
  serviceConnectionProviders?: () => readonly import("@woohaa3/contracts").GenerationProvider[];
  serviceConnections?: import("../service-connections/registry.js").ServiceConnectionRegistry | null;

  /**
   * 内置 MCP 真实发现（change: 2026-10-12-add-agent-conversation-panel，任务 3.1/3.2）。
   *
   * 宿主注入后端 executed initialize/tools/list 结果；缺失时 `GET /mcp` 返回 not-configured，
   * 绝不伪造 ready。外部连接指引由 handler 用请求 origin 派生。
   */
  mcpDiscovery?: () => Promise<import("@woohaa3/contracts").McpBuiltinDiscoveryView>;
  /** 当前公开挂载路径；外部 MCP 指引 URL 在其上派生（change: 2026-10-15-...）。 */
  basePath?: string;
  /**
   * 单次 HTTP 请求体的传输分块上界（change: 2026-10-22-remove-agent-execution-limits，任务 4.4）。
   *
   * 这是传输/解析参数：一次请求只携带一份 intent（prompt + 引用 identity），不是完整作品
   * 总量额度。作品内容（脚本、计划、模型、片段）走各自的完整提交路径，不受此值限制。
   */
  maxRequestBytes?: number;
  logger?: (event: Record<string, unknown>) => void;
};

export type AgentConversationApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

/**
 * 错误码 → HTTP 状态。
 *
 * change: 2026-10-22-remove-agent-execution-limits，任务 3.1：`conversation-busy` 与
 * `budget-exceeded` 是**历史契约码**，受理与执行不再产生它们；保留映射只为旧客户端与旧
 * 回执继续可读，不构成可用的拒绝路径。
 */
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
  "storage-failed": 500,
  "active-turn": 409
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
      if (suffix === "group-executions" && method === "GET") {
        const canvasId = url.searchParams.get("canvasId") ?? "";
        const allowed = await authorizeCanvas(deps, owner, canvasId, "read");
        if (!allowed.ok) return respondError(res, allowed.error);
        const limit = Number(url.searchParams.get("limit") ?? 50);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) return badRequest(res, "limit 必须在 1–200 之间");
        try {
          sendJson(res, 200, deps.service.listGroupExecutions({ owner, canvasId, limit,
            nodeId: url.searchParams.get("nodeId") ?? undefined, cursor: url.searchParams.get("cursor") ?? undefined }));
        } catch { return badRequest(res, "无效组执行分页游标"); }
        return true;
      }
      if (suffix === "service-connections" && method === "GET") {
        let administrator = deps.accessRuntime?.enabled === false;
        if (!administrator && deps.accessEnforcer) {
          try { await deps.accessEnforcer.assertAction(principal, APPLICATION_EXTENSION_LOAD_ACTION); administrator = true; } catch { /* Read-only shared view. */ }
        }
        const actor = { owner, administrator, canUseSite: true };
        sendJson(res, 200, { connections: await deps.serviceConnections?.list(actor) ?? [], duplicates: await deps.serviceConnections?.suspectedDuplicates(actor) ?? [], providers: (deps.serviceConnectionProviders?.() ?? []).filter(provider => provider.serviceConnectionFactory).map(provider => ({ providerId: provider.providerId, protocols: provider.serviceConnectionFactory!.protocols, models: provider.models.map(model => ({ modelId: model.providerModelId, modelKey: `${provider.providerId}:${model.providerModelId}`, type: model.modelType })) })) });
        return true;
      }
      if ((suffix === "service-connections/protocol" || suffix === "service-connections/enabled") && method === "POST") {
        const origin = firstHeader(req.headers.origin);
        if (!sameSourceOrigin(req, origin)) { sendJson(res, 403, { code: "forbidden", message: "需要同源请求" }); return true; }
        const input = await readJson(req, maxBytes) as Record<string, unknown>;
        if (!input || typeof input.serviceConnectionId !== "string" || ![input.configRevision, input.credentialEpoch].every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) return badRequest(res, "来源和版本无效");
        let administrator = deps.accessRuntime?.enabled === false;
        if (!administrator && deps.accessEnforcer) { try { await deps.accessEnforcer.assertAction(principal, APPLICATION_EXTENSION_LOAD_ACTION); administrator = true; } catch { /* Personal source only. */ } }
        const actor = { owner, administrator, canUseSite: true };
        const expected = { configRevision: input.configRevision as number, credentialEpoch: input.credentialEpoch as number };
        if (!deps.serviceConnections) return badRequest(res, "服务连接未装配");
        if (suffix.endsWith("/enabled")) {
          if (typeof input.enabled !== "boolean") return badRequest(res, "启用状态无效");
          sendJson(res, 200, { connection: await deps.serviceConnections.setEnabled(actor, input.serviceConnectionId, expected, input.enabled) }); return true;
        }
        const endpoint = input.endpoint as Record<string, unknown> | undefined;
        if (!endpoint || !["responses", "messages", "chat-completions", "gemini"].includes(String(endpoint.protocol)) || typeof endpoint.baseUrl !== "string" || !Array.isArray(input.models) || !input.models.every(model => typeof model === "string" && model.trim())) return badRequest(res, "协议入口和模型无效");
        sendJson(res, 200, { connection: await deps.serviceConnections.addProtocol(actor, input.serviceConnectionId, expected, endpoint as unknown as import("@woohaa3/contracts").ServiceConnectionEndpoint, input.models as string[]) }); return true;
      }
      if (suffix === "service-connections/merge" && method === "POST") {
        const origin = firstHeader(req.headers.origin);
        if (!sameSourceOrigin(req, origin)) { sendJson(res, 403, { code: "forbidden", message: "需要同源请求" }); return true; }
        const input = await readJson(req, maxBytes) as Record<string, unknown>;
        const validVersion = (value: unknown) => !!value && typeof value === "object" && ["configRevision", "credentialEpoch"].every(key => { const entry = (value as Record<string, unknown>)[key]; return typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0; });
        if (!input || typeof input.operationId !== "string" || input.operationId.length > 128 || typeof input.retainedId !== "string" || typeof input.removedId !== "string" || !validVersion(input.retained) || !validVersion(input.removed)) return badRequest(res, "合并操作和版本无效");
        let administrator = deps.accessRuntime?.enabled === false;
        if (!administrator && deps.accessEnforcer) { try { await deps.accessEnforcer.assertAction(principal, APPLICATION_EXTENSION_LOAD_ACTION); administrator = true; } catch { /* Personal merge only. */ } }
        if (!deps.serviceConnections) return badRequest(res, "服务连接未装配");
        const connection = await deps.serviceConnections.merge({ owner, administrator, canUseSite: true }, input as unknown as Parameters<NonNullable<typeof deps.serviceConnections>["merge"]>[1]);
        sendJson(res, 200, { connection }); return true;
      }
      if (suffix === "service-connections/provider" && method === "POST") {
        const origin = firstHeader(req.headers.origin);
        if (!sameSourceOrigin(req, origin)) { sendJson(res, 403, { code: "forbidden", message: "需要同源请求" }); return true; }
        const input = await readJson(req, maxBytes) as Record<string, unknown>;
        if (!input || typeof input.serviceConnectionId !== "string" || typeof input.providerId !== "string" || typeof input.modelId !== "string" || ![input.configRevision, input.credentialEpoch].every(value => typeof value === "number" && Number.isSafeInteger(value))) return badRequest(res, "来源、模型和版本无效");
        const actor = { owner, administrator: false, canUseSite: true };
        const source = await deps.serviceConnections?.get(actor, input.serviceConnectionId);
        if (!source || source.scope !== "personal") return badRequest(res, "请选择自己的个人 API 来源");
        if (source.configRevision !== input.configRevision || source.credentialEpoch !== input.credentialEpoch) { sendJson(res, 409, { code: "stale", message: "来源已变化，请重新确认" }); return true; }
        const provider = deps.serviceConnectionProviders?.().find(provider => provider.providerId === input.providerId && provider.serviceConnectionFactory);
        const model = provider?.models.find(model => model.providerModelId === input.modelId && model.modelType === "language");
        const endpoint = source.endpoints.find(endpoint => provider?.serviceConnectionFactory?.protocols.includes(endpoint.protocol));
        if (!provider || !model || !endpoint || !source.capabilities.some(capability => capability.modelId === model.providerModelId && capability.protocol === endpoint.protocol && capability.purpose === "discussion")) return badRequest(res, "此来源或 Provider 未提供所选模型的文本生成适配");
        const connection = await deps.serviceConnections!.bind(actor, source.serviceConnectionId, { bindingId: `provider:${provider.providerId}`,
          extensionId: provider.extensionId, consumer: "provider", consumerId: provider.providerId, purposes: ["text"], modelKeys: [...new Set([...(source.bindings.find(binding => binding.bindingId === `provider:${provider.providerId}`)?.modelKeys ?? []), `${provider.providerId}:${model.providerModelId}`])] }, source,
          [...source.capabilities.filter(capability => !(capability.purpose === "text" && capability.protocol === endpoint.protocol && capability.modelId === model.providerModelId)),
            { purpose: "text", protocol: endpoint.protocol, modelId: model.providerModelId, imageInput: false, evidence: "adapter" }]);
        sendJson(res, 200, { connection }); return true;
      }
      if (suffix === "service-connections/assistant" && method === "POST") {
        const origin = firstHeader(req.headers.origin);
        if (!sameSourceOrigin(req, origin)) { sendJson(res, 403, { code: "forbidden", message: "需要同源管理请求" }); return true; }
        if (deps.accessRuntime?.enabled !== false) {
          if (!deps.accessEnforcer) { sendJson(res, 403, { code: "forbidden", message: "管理授权不可用" }); return true; }
          await deps.accessEnforcer.assertAction(principal, APPLICATION_EXTENSION_LOAD_ACTION);
        }
        const input = await readJson(req, maxBytes) as Record<string, unknown>;
        if (!input || typeof input.serviceConnectionId !== "string" || typeof input.enabled !== "boolean" || ![input.configRevision, input.credentialEpoch].every(value => typeof value === "number" && Number.isSafeInteger(value))) return badRequest(res, "来源和冻结版本无效");
        const actor = { owner, administrator: true, canUseSite: true };
        const source = await deps.serviceConnections?.get(actor, input.serviceConnectionId);
        if (!source || source.scope !== "site") return badRequest(res, "请选择站点共享来源");
        const expected = { configRevision: input.configRevision as number, credentialEpoch: input.credentialEpoch as number };
        const bindingId = `shared-sdk:${source.serviceConnectionId}`;
        const connection = input.enabled ? await deps.serviceConnections!.bind(actor, source.serviceConnectionId, {
          bindingId, extensionId: "sdk-agent", consumer: "agent", consumerId: "shared:chat-completions", purposes: ["discussion"],
          modelKeys: source.capabilities.filter(capability => capability.purpose === "discussion" && capability.protocol === "chat-completions").map(capability => capability.modelId),
        }, expected) : await deps.serviceConnections!.unbind(actor, source.serviceConnectionId, bindingId, expected);
        sendJson(res, 200, { connection }); return true;
      }
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
        const result = deps.service.createConversation({ owner, canvasId: decoded.value.canvasId, ...(decoded.value.contextKey ? { contextKey: decoded.value.contextKey } : {}), ...(decoded.value.adapterId ? { adapterId: decoded.value.adapterId } : {}), ...(decoded.value.title ? { title: decoded.value.title } : {}), ...(decoded.value.nodeId ? { nodeId: decoded.value.nodeId } : {}), ...(decoded.value.connectionId ? { connectionId: decoded.value.connectionId } : {}) });
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
        const contextKey = url.searchParams.get("contextKey") ?? undefined;
        if (contextKey !== undefined && (!contextKey || contextKey.length > 128)) return badRequest(res, "contextKey 非法");
        const result = deps.service.findConversationForTarget({ owner, canvasId, nodeId, ...(contextKey ? { contextKey } : {}), ...(connectionId ? { connectionId } : {}) });
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

      // Skill 媒体步骤：按节点读取当前尝试、事件重放、用户停止与重新生成
      // （change: 2026-10-28-add-agent-skill-media-regeneration，任务 5.1/5.2）。
      if (suffix === "skill-steps/by-node" && method === "GET") {
        if (!deps.skillMedia) return respondSkillError(res, { code: "unavailable", message: "Skill 续接未启用" });
        const canvasId = url.searchParams.get("canvasId") ?? "";
        const nodeId = url.searchParams.get("nodeId") ?? "";
        if (!canvasId || !nodeId) return badRequest(res, "canvasId 与 nodeId 必填");
        const allowed = await authorizeCanvas(deps, owner, canvasId, "read");
        if (!allowed.ok) return respondError(res, allowed.error);
        const result = await deps.skillMedia.snapshotByNode({ owner, canvasId, nodeId });
        if (!result.ok) return respondSkillError(res, result);
        sendJson(res, 200, { ok: true, step: result.step });
        return true;
      }
      if (suffix === "skill-steps" && method === "GET") {
        if (!deps.skillMedia) return respondSkillError(res, { code: "unavailable", message: "Skill 续接未启用" });
        const canvasId = url.searchParams.get("canvasId") ?? "";
        if (!canvasId) return badRequest(res, "canvasId 必填");
        const allowed = await authorizeCanvas(deps, owner, canvasId, "read");
        if (!allowed.ok) return respondError(res, allowed.error);
        const limit = Number(url.searchParams.get("limit") ?? 50);
        if (!Number.isInteger(limit) || limit < 1) return badRequest(res, "limit 必须是正整数");
        const result = await deps.skillMedia.list({ owner, canvasId, limit });
        if (!result.ok) return respondSkillError(res, result);
        sendJson(res, 200, { ok: true, steps: result.steps });
        return true;
      }
      const skillStepRead = /^skill-steps\/([^/]+)\/([^/]+)$/.exec(suffix);
      if (skillStepRead && method === "GET") {
        if (!deps.skillMedia) return respondSkillError(res, { code: "unavailable", message: "Skill 续接未启用" });
        const canvasId = url.searchParams.get("canvasId") ?? "";
        if (!canvasId) return badRequest(res, "canvasId 必填");
        const allowed = await authorizeCanvas(deps, owner, canvasId, "read");
        if (!allowed.ok) return respondError(res, allowed.error);
        const skillRunId = decodeURIComponent(skillStepRead[1]!);
        const stepId = decodeURIComponent(skillStepRead[2]!);
        const after = Number(url.searchParams.get("after") ?? 0);
        if (!Number.isInteger(after) || after < 0) return badRequest(res, "after 必须是非负整数");
        const snapshot = await deps.skillMedia.snapshot({ owner, canvasId, skillRunId, stepId });
        if (!snapshot.ok) return respondSkillError(res, snapshot);
        const page = await deps.skillMedia.events({ owner, canvasId, skillRunId, stepId, after: after > 0 ? after - 1 : 0, limit: 200 });
        if (!page.ok) return respondSkillError(res, page);
        sendJson(res, 200, { ok: true, step: snapshot.step, events: page.page.events, cursor: page.page.cursor, resetRequired: page.page.resetRequired });
        return true;
      }
      const skillStepCancel = /^skill-steps\/([^/]+)\/([^/]+)\/cancel$/.exec(suffix);
      if (skillStepCancel && method === "POST") {
        if (!deps.skillMedia) return respondSkillError(res, { code: "unavailable", message: "Skill 续接未启用" });
        const body = await readJson(req, maxBytes);
        if (body === null || typeof body !== "object" || Array.isArray(body)) return badRequest(res, "请求体非法");
        const input = body as Record<string, unknown>;
        const canvasId = typeof input.canvasId === "string" ? input.canvasId : "";
        if (!canvasId) return badRequest(res, "canvasId 必填");
        const allowed = await authorizeCanvas(deps, owner, canvasId, "write");
        if (!allowed.ok) return respondError(res, allowed.error);
        const result = await deps.skillMedia.cancel({ owner, canvasId, skillRunId: decodeURIComponent(skillStepCancel[1]!), stepId: decodeURIComponent(skillStepCancel[2]!) });
        if (!result.ok) return respondSkillError(res, result);
        sendJson(res, 200, { ok: true, step: result.step, state: result.state });
        return true;
      }
      const skillStepRegenerate = /^skill-steps\/([^/]+)\/([^/]+)\/regenerate$/.exec(suffix);
      if (skillStepRegenerate && method === "POST") {
        if (!deps.skillMedia) return respondSkillError(res, { code: "unavailable", message: "Skill 续接未启用" });
        const body = await readJson(req, maxBytes);
        if (body === null || typeof body !== "object" || Array.isArray(body)) return badRequest(res, "请求体非法");
        const input = body as Record<string, unknown>;
        const canvasId = typeof input.canvasId === "string" ? input.canvasId : "";
        const requestId = typeof input.requestId === "string" ? input.requestId : "";
        if (!canvasId || !requestId) return badRequest(res, "canvasId 与 requestId 必填");
        const allowed = await authorizeCanvas(deps, owner, canvasId, "write");
        if (!allowed.ok) return respondError(res, allowed.error);
        const result = await deps.skillMedia.replace({
          owner,
          canvasId,
          skillRunId: decodeURIComponent(skillStepRegenerate[1]!),
          stepId: decodeURIComponent(skillStepRegenerate[2]!),
          requestId,
          ...(typeof input.runId === "string" ? { runId: input.runId } : {}),
          ...(typeof input.prompt === "string" ? { prompt: input.prompt } : {}),
          ...(typeof input.modelKey === "string" ? { modelKey: input.modelKey } : {}),
          ...(input.parameters && typeof input.parameters === "object" && !Array.isArray(input.parameters) ? { parameters: input.parameters as Record<string, unknown> } : {})
        });
        if (!result.ok) return respondSkillError(res, result);
        sendJson(res, 200, { ok: true, step: result.step, runId: result.runId });
        return true;
      }

      const conversationRead = /^conversations\/([^/]+)$/.exec(suffix);
      if (conversationRead && method === "GET") {
        const conversationId = decodeURIComponent(conversationRead[1]!);
        const cursor = decodeCursorQuery(url.searchParams.get("cursor"));
        // 分页读取（change: 2026-10-22-remove-agent-execution-limits，任务 4.1）：游标只是单次
        // 传输片段，完整历史可以继续向前读取，不做总量截断。
        const beforeMessageSequence = readPositiveIntQuery(url.searchParams.get("beforeMessageSequence"));
        const turnOffset = readNonNegativeIntQuery(url.searchParams.get("turnOffset"));
        const result = deps.service.readConversation({
          owner,
          conversationId,
          cursor,
          ...(beforeMessageSequence !== undefined ? { beforeMessageSequence } : {}),
          ...(turnOffset !== undefined ? { turnOffset } : {})
        });
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
        const text = decoded.value.entry.mode === "text" && decoded.value.entry.action !== "discuss";
        if (text && !deps.assistantText) return badRequest(res, "文本交付端口未装配");
        const acceptInput = { owner, conversationId: acceptedConversationId, requestId: decoded.value.requestId, entry: decoded.value.entry, connection: connection.binding };
        const accepted = text ? await deps.assistantText!.accept(acceptInput) : deps.service.acceptTurn(acceptInput);
        if (!accepted.ok) return respondError(res, accepted.error);
        if (!text && !accepted.reused) void deps.service.dispatchTurn(accepted.turn.turnId);
        sendJson(res, 200, { conversation: accepted.conversation, turn: accepted.turn, reused: accepted.reused });
        return true;
      }

      const textRetry = /^turns\/([^/]+)\/retry-save$/.exec(suffix);
      if (textRetry && method === "POST") {
        const requestId = decodeURIComponent(textRetry[1]!);
        const known = deps.assistantText?.peek(owner, requestId);
        if (!known) return badRequest(res, "文本执行不存在");
        const allowed = await authorizeCanvas(deps, owner, known.canvasId, "write");
        if (!allowed.ok) return respondError(res, allowed.error);
        try {
          const result = await deps.assistantText!.retry(owner, requestId);
          if (!result.ok) return respondError(res, result.error);
          sendJson(res, 200, result);
        } catch (error) {
          if (error instanceof Error && "code" in error) return badRequest(res, error.message);
          throw error;
        }
        return true;
      }
      const turnQuery = /^turns\/([^/]+)$/.exec(suffix);
      if (turnQuery && method === "GET") {
        const requestId = decodeURIComponent(turnQuery[1]!);
        const original = deps.service.queryTurn({ owner, requestId });
        if (!original.ok) return respondError(res, original.error);
        const allowed = await authorizeCanvas(deps, owner, original.turn.target.canvasId, "read");
        if (!allowed.ok) return respondError(res, allowed.error);
        await deps.assistantText?.reconcile(owner, requestId);
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
        const text = deps.assistantText?.peek(owner, requestId);
        if (text) { const allowed = await authorizeCanvas(deps, owner, text.canvasId, "write"); if (!allowed.ok) return respondError(res, allowed.error); }
        const result = text ? await deps.assistantText!.cancel(owner, requestId) : deps.service.cancelTurn({ owner, requestId });
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
        if (deps.assistantText?.peek(owner, requestId)) return badRequest(res, "文本执行关联由宿主维护");
        const result = deps.service.linkRun({ owner, requestId, ...(decoded.value.runId ? { runId: decoded.value.runId } : {}), ...(decoded.value.taskId ? { taskId: decoded.value.taskId } : {}) });
        if (!result.ok) return respondError(res, result.error);
        sendJson(res, 200, { turn: result.turn });
        return true;
      }

      sendError(res, 404, "extension-not-found", "未知的会话路由");
      return true;
    } catch (error) {
      if (suffix.startsWith("service-connections") && error instanceof Error && "code" in error) {
        const code = String(error.code);
        sendJson(res, code === "forbidden" ? 403 : code === "not-found" ? 404 : ["stale", "conflict", "locked"].includes(code) ? 409 : 400, { code, message: error.message }); return true;
      }
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

function respondSkillError(res: ServerResponse, error: { code: string; message: string }): true {
  const status = error.code === "unauthorized" ? 401
    : error.code === "forbidden" || error.code === "group-scope-revoked" ? 403
    : error.code === "skill-step-not-found" ? 404
    : error.code === "unavailable" ? 503
    : error.code === "request-id-reused" || error.code === "skill-attempt-superseded" ? 409
    : 400;
  sendJson(res, status, { code: error.code, message: error.message, protocolVersion: WOOHAA3_PROTOCOL_VERSION });
  return true;
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
function sameSourceOrigin(req: IncomingMessage, origin: string | undefined): boolean {
  if (!origin) return false;
  try { return new URL(origin).origin === new URL(externalMcpUrl(req, "/")).origin; } catch { return false; }
}

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

/** 读取正整数查询参数（分页游标）；非法或缺省返回 undefined（按默认页处理）。 */
function readPositiveIntQuery(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** 读取非负整数查询参数（分页偏移）；非法或缺省返回 undefined。 */
function readNonNegativeIntQuery(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
