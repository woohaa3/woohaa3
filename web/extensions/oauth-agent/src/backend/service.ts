/**
 * ChatGPT 授权/生成服务组合根
 * （change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 3.1–3.5 / design D1/D4）。
 *
 * 只做组合：配置解析 → 凭据仓库 → owner resolver → OAuth → 授权服务 → Codex SDK 适配器 →
 * 生成编排 → `/api/oauth-agent/*` handler。所有领域写入都经注入的 Canvas 权威端口；本服务不
 * 直接写 Y.Doc/数据库，也不把 token 交给任何下游。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { WOOHAA3_PROTOCOL_VERSION, CANVAS_WORKSPACE_TOOLS } from "@woohaa3/contracts";
import { createChatGptCredentialStore } from "./credentials.js";
import { createOwnerResolver, deriveSessionSecret } from "./identity.js";
import { ChatGptOAuth } from "./oauth.js";
import { createChatGptAuthorizationService, type ChatGptAuthorizationService } from "./authorization.js";
import { createChatGptModelCatalog } from "./models.js";
import { createExecutorCodexAdapter } from "./execution-client.js";
import { type CodexAdapter } from "./codex-adapter.js";
import { createChatGptGenerationService, type ChatGptGenerationService } from "./generation.js";
import { createChatGptWorkJournal, type ChatGptWorkJournal } from "./work-journal.js";
import { createChatGptApiHandler } from "./handler.js";
import { resolveChatGptServiceConfig, isLoopbackOrigin, type ChatGptServiceConfig } from "./config.js";
import type { ChatGptCanvasPorts } from "./ports.js";

export type ChatGptServiceOptions = {
  env?: Record<string, string | undefined>;
  /** Canvas 权威端口（测试注入 fake；生产由统一后端注入）。 */
  canvasPorts: ChatGptCanvasPorts;
  /** 是否配置了可信应用认证适配器。 */
  authConfigured: boolean;
  /** 从请求解析可信 principal.subject（无认证适配器时返回 null）。 */
  resolvePrincipalSubject?: (req: IncomingMessage) => string | null;
  /** 工具授权门（任务 3.6）：工具模式回合签发受控 grant，工具入口据此强制校验。 */
  toolGrants?: import("@woohaa3/contracts").ApplicationToolDelegationFacade;
  /** 强制公网姿态（测试/部署）；缺省由回调 origin 推导。 */
  publicPosture?: boolean;
  /** 显式本地开发姿态（测试）；缺省由 `WOOHAA3_CHATGPT_ALLOW_LOCAL_CALLBACK` 推导。 */
  localDev?: boolean;
  executor?: import("@woohaa3/contracts").ApplicationExtensionExecutorFacade;
  /** OAuth/JWKS/模型目录 fetch 覆盖（测试注入）。 */
  fetchImpl?: typeof globalThis.fetch;
  /** JWKS 解析器覆盖（测试注入本地 JWKS）。 */
  jwks?: import("jose").JWTVerifyGetKey;
  /** 允许的同源 Origin 集合（回调 origin）；缺省由回调 origin 推导。 */
  allowedOrigins?: readonly string[];
  basePath?: string;
  /**
   * 当前公开挂载路径（change: 2026-10-15-support-configurable-app-base-path）。
   * 决定 OAuth 回调 redirect URI 的调用路径（须与可信 origin 上的挂载一致）。
   */
  deploymentBasePath?: string;
  logger?: (event: Record<string, unknown>) => void;
  now?: () => number;
  /**
   * 宿主角色准备（change: 2026-11-07-add-pluggable-agent-roles）。
   *
   * 业务入口只提交角色 id 与输入；准备、能力匹配与规范消息由宿主完成。缺失时直连生成入口
   * 明确不可用，不回退到自带的业务模板。
   */
  prepareGenerationRole?: (input: {
    ownerId: string;
    request: import("@woohaa3/contracts").ChatGptGenerateRequest;
  }) => Promise<{ ok: true; prepared: import("@woohaa3/contracts").PreparedAgentRoleTurn } | { ok: false; code: string; message: string }>;
};

export type ChatGptService = {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  enabled: boolean;
  disabledReason?: string;
  /** 实际凭据目录（部署证据）。 */
  credentialDirectory: () => string | null;
  /** 实际隔离 Codex HOME 根目录（部署证据）。 */
  codexHomeDirectory: () => string | null;
  authorization: ChatGptAuthorizationService | null;
  generation: ChatGptGenerationService | null;
  /** 服务端凭据仓库（仅进程内引用；不经公开面暴露 token）。 */
  credentials: import("./credentials.js").ChatGptCredentialStore | null;
  /** durable 工作日志（恢复/回执核验；design D6/D7）。 */
  workJournal: ChatGptWorkJournal;
  /**
   * 显式宿主 identity port：把本插件**自身已有**的本地 HttpOnly 会话复用为宿主可用身份
   * （change: 2026-10-12-add-agent-conversation-panel，任务 1.3 / design D2）。
   *
   * 仅在无应用认证、非公网姿态且允许本地会话时返回 `{ subject: "local:<id>", sessionId, setCookie? }`；
   * 生产 principal 模式返回 null（宿主认证适配器才是唯一身份来源）。宿主会话 API 据此复用同一
   * 浏览器会话，MUST NOT 另造浏览器 ID。
   */
  localSessionIdentity: (req: IncomingMessage) => { subject: string; sessionId: string; setCookie?: string } | null;
  /**
   * 仅讨论回合：无工具面、无 shell/文件写入/web search 的纯多轮推理
   * （change: 2026-10-12-add-agent-conversation-panel，任务 2.3）。
   *
   * 历史只当内容，不继承旧工具授权；不配置 MCP、不使用静态 bearer。SDK 只提供完整
   * `agent_message` 与阶段，界面不伪造 token 流。未启用（disabled）时返回 available=false。
   */
  converse: (input: {
    requestId: string;
    prepared: import("@woohaa3/contracts").PreparedAgentRoleTurn;
    ownerId: string;
    model: string;
    reasoningEffort?: import("@woohaa3/contracts").ChatGptReasoningEffort;
    prompt: string;
    history: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
    images?: readonly import("./codex-adapter.js").CodexImageAttachment[];
    outputSchema?: Record<string, unknown>;
    signal?: AbortSignal;
    onStage?: (stage: string) => void;
    onTool?: (event: import("./codex-adapter.js").CodexRunEvent) => void;
  }) => Promise<{ ok: true; text: string } | { ok: false; code: string; message: string }>;
  close: () => Promise<void>;
};

export function createChatGptService(options: ChatGptServiceOptions): ChatGptService {
  const log = options.logger ?? (() => undefined);
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const resolved = resolveChatGptServiceConfig(env, options.deploymentBasePath);
  if (!resolved.ok) {
    const disabledBase = (options.basePath ?? "/api/oauth-agent").replace(/\/$/, "");
    return {
      enabled: false,
      disabledReason: resolved.reason,
      credentialDirectory: () => null,
      codexHomeDirectory: () => null,
      authorization: null,
      generation: null,
      credentials: null,
      workJournal: createChatGptWorkJournal({ logger: (event) => log({ module: "chatgpt-work", ...event }) }),
      // 未配置时不存在可信本地会话；宿主不伪造身份（任务 1.3）。
      localSessionIdentity: () => null,
      converse: async () => ({ ok: false, code: "not-configured", message: resolved.reason }),
      handle: async (req, res) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (pathname !== disabledBase && !pathname.startsWith(`${disabledBase}/`)) return false;
        // 明确不可用状态；不静默回退到临时目录或 404 冒充未注册。
        const payload = JSON.stringify({ code: "not-configured", message: resolved.reason, protocolVersion: WOOHAA3_PROTOCOL_VERSION, CANVAS_WORKSPACE_TOOLS });
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
        res.end(payload);
        return true;
      },
      close: async () => undefined
    };
  }
  const config: ChatGptServiceConfig = resolved.config;
  // 公网姿态：显式强制，或配置了非 loopback 回调 origin（缺省 false=本地）。公网缺少可信认证时
  // 由 owner resolver 拒绝匿名 fallback。
  const publicPosture = options.publicPosture ?? (config.callbackOrigin !== null && !isLoopbackOrigin(config.callbackOrigin));
  const allowLocalSession = config.allowLocalCallback;
  const secure = config.callbackOrigin?.startsWith("https:") ?? false;

  const store = createChatGptCredentialStore({ directory: config.credentialDir, masterKey: config.masterKey });
  const owners = createOwnerResolver({
    authConfigured: options.authConfigured,
    resolvePrincipalSubject: options.resolvePrincipalSubject ?? (() => null),
    publicPosture,
    allowLocalSession,
    sessionSecret: deriveSessionSecret(config.masterKey),
    secure,
    ...(options.deploymentBasePath ? { basePath: options.deploymentBasePath } : {}),
    ...(options.now ? { now: options.now } : {})
  });

  /**
   * 显式宿主 identity port 实现（任务 1.3 / design D2）：只在**纯本地开发**姿态下，把本插件
   * 自身已签发的 HttpOnly 会话复用为宿主会话 owner。生产 principal 模式或公网姿态返回 null，
   * 宿主认证适配器是唯一身份来源；绝不从请求自报或另造浏览器 ID。
   */
  const localSessionIdentity = (req: IncomingMessage): { subject: string; sessionId: string; setCookie?: string } | null => {
    if (options.authConfigured || publicPosture || !allowLocalSession) return null;
    const resolved = owners.resolve(req);
    if (!resolved.ok || resolved.ownerKind !== "local-session") return null;
    return {
      subject: resolved.ownerId,
      sessionId: resolved.ownerId,
      ...(resolved.setCookie ? { setCookie: resolved.setCookie } : {})
    };
  };

  const oauth = new ChatGptOAuth({
    issuer: config.issuer,
    appClientId: config.appClientId,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.jwks ? { jwks: options.jwks } : {}),
    ...(options.now ? { now: options.now } : {})
  });

  const authorization = createChatGptAuthorizationService({
    store,
    oauth,
    owners,
    ...(options.now ? { now: options.now } : {})
  });

  const models = createChatGptModelCatalog({ ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });

  const codex: CodexAdapter = createExecutorCodexAdapter({
    executor: options.executor,
    codexHomeDir: config.codexHomeDir,
    workspaceDir: config.workspaceDir,
    codexBin: config.codexBin,
    accessTokenFor: (ownerId) => authorization.ensureAccessToken(ownerId),
    // 受控 MCP 工具面（design D4b）：默认连本应用同源 MCP 端点（与应用既有 Agent 工具板同一信任边界）。
    mcpTools: { name: "woohaa3_model_canvas", url: config.mcpUrl },
    logger: (event) => log({ module: "chatgpt-codex", ...event })
  });

  const workJournal = createChatGptWorkJournal({
    directory: config.credentialDir,
    ...(options.now ? { now: () => new Date(options.now!()) } : {}),
    logger: (event) => log({ module: "chatgpt-work", ...event })
  });

  const generation = createChatGptGenerationService({
    ports: options.canvasPorts,
    codex,
    workJournal,
    ...(options.toolGrants ? { toolGrants: options.toolGrants } : {}),
    logger: (event) => log({ module: "chatgpt-generation", ...event })
  });
  // 启动恢复：中断遗留工作标记 outcome-unknown（不自动重推理；任务 4.6 / design D7）。
  generation.recoverInterrupted();

  const allowedOrigins = options.allowedOrigins ?? (config.callbackOrigin ? [config.callbackOrigin] : []);
  const handler = createChatGptApiHandler({
    enabled: true,
    owners,
    authorization,
    generation,
    models: { list: (token) => models.list(token) },
    ...(options.prepareGenerationRole ? { prepareGenerationRole: options.prepareGenerationRole } : {}),
    onOwnerDisconnect: (ownerId) => {
      generation.cancelOwner(ownerId);
      // 断开/重绑改变授权 epoch：旧在途工作的授权已失效（任务 4.1 / design D5）。
      workJournal.bumpAuthEpoch();
    },
    allowedOrigins,
    localDev: allowLocalSession || options.localDev === true,
    ...(options.basePath ? { basePath: options.basePath } : {}),
    ...(options.deploymentBasePath ? { deploymentBasePath: options.deploymentBasePath } : {}),
    logger: (event) => log({ module: "chatgpt-api", ...event })
  });

  return {
    enabled: true,
    credentialDirectory: () => store.directory(),
    codexHomeDirectory: () => config.codexHomeDir,
    authorization,
    generation,
    credentials: store,
    workJournal,
    localSessionIdentity,
    converse: async (input) => {
      try {
        await authorization.ensureAccessToken(input.ownerId);
      } catch (error) {
        return { ok: false as const, code: "authorization-required", message: error instanceof Error ? error.message : "授权不可用" };
      }
      const prompt = buildConversationPrompt(input.history, input.prompt);
      const workspace = input.prepared.workspace;
      let grant: string | undefined;
      try {
        if (workspace) {
          if (workspace.requestId !== input.requestId || !options.toolGrants || input.prepared.tools.some(tool => !CANVAS_WORKSPACE_TOOLS.includes(tool as never))) throw new Error("桌面讨论辅助工具授权不可用");
          grant = (await options.toolGrants.issue({ delegation: { subject: workspace.owner, authLevel: "authenticated" }, workId: workspace.requestId, canvasId: workspace.canvasId, nodeId: "", tools: input.prepared.tools })).token;
        }
        const { finalResponse } = await codex.runStreamed(
          { ownerId: input.ownerId, requestId: input.requestId, prepared: input.prepared, model: input.model, ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}), prompt, noTools: !grant, ...(grant ? { mcpGrantToken: grant } : {}), ...(input.images ? { images: input.images } : {}), ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}), ...(input.signal ? { signal: input.signal } : {}) },
          (event) => {
            if (event.type === "progress") input.onStage?.(event.stage);
            else if (event.type === "tool" || event.type === "tool-started") input.onTool?.(event);
          }
        );
        return { ok: true as const, text: finalResponse };
      } catch (error) {
        return { ok: false as const, code: "inference-failed", message: error instanceof Error ? error.message : "讨论推理失败" };
      } finally { if (grant && workspace) options.toolGrants?.revoke(workspace.requestId, { subject: workspace.owner, authLevel: "authenticated" }); }
    },
    handle: handler,
    close: async () => {
      generation.dispose();
      workJournal.close();
      log({ event: "chatgpt-service-closed" });
    }
  };
}

/**
 * 从宿主提供的合法已完成历史重组多轮提示词
 * （change: 2026-10-12-add-agent-conversation-panel，任务 2.2）。
 *
 * 历史**只是内容**：明确声明不继承旧工具权限，不暴露隐式推理。超限由宿主上下文预算处理；
 * 这里只做有界截断，不静默丢弃用户显式引用（引用由 adapter 层在超限时拒绝）。
 */
export function buildConversationPrompt(
  history: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
  prompt: string
): string {
  const lines: string[] = [
    "你是 Woohaa3 Model Canvas 的创作助手，只进行讨论。当前回合没有画布写入、MCP 工具、shell 或文件写入能力；历史内容仅是上下文参考，不代表任何已授权操作，也不要声称已修改画布。"
  ];
  if (history.length > 0) {
    lines.push("", "以下是本对话之前的合法消息（仅作为内容参考）：");
    for (const message of history) {
      lines.push(`${message.role === "user" ? "用户" : "助手"}：${message.content}`);
    }
  }
  lines.push("", `用户：${prompt}`);
  return lines.join("\n");
}
