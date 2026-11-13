import { nativeContextFor, nativeContextKey } from "@woohaa3/agent-connections";
/**
 * local-agent 连接描述与会话 adapter 装配
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 3.1/4.2/6.2/6.4 / design D3/D5/D6）。
 *
 * 把本机适配器元数据、专用进程管理与连接服务组合成：
 * - `AgentConnectionProvider`（`agent-connection-provider:local-agent`）；
 * - `AgentConversationAdapter`（每个 adapterId 一个）。
 *
 * 关键边界：
 * - 加载/激活**不**创建进程；只有显式执行才 `ensure` 专用进程（本函数内）；
 * - 工具范围逐次经宿主 grant 校验；无 grant 时不注入工具面；
 * - 缺 CLI/版本不支持 → `runtime-missing`/`version-unsupported`，不影响基础健康。
 */
import {
  AGENT_READ_ONLY_TOOLS,
  agentReasoningRevision,
  reasoningCapabilityOf,
  type AgentAdapterAuthState,
  type AgentAdapterRunInput,
  type AgentAdapterRunOutcome,
  type AgentImageInput,
  type AgentAdapterCapabilities,
  type AgentCatalogSnapshot,
  type AgentModelView,
  type AgentConnectionCapabilities,
  type AgentConversationAdapter,
  type ApplicationToolDelegationFacade
} from "@woohaa3/contracts";
import { ASSISTANT_CANDIDATE_CAPABILITIES, createTurnObserver, modelCatalogForRecord, preflightInput, preparedPromptText, type ConnectionDescriptor, type ConnectionService } from "@woohaa3/agent-connections";
import { LOCAL_AGENT_ADAPTERS, LOCAL_AGENT_PLUGIN_ID, localAgentConnectionName, type LocalAgentAdapterDescriptor } from "../shared.js";
import { generatedImageImportFailure } from "./generated-image-import.js";
import type { ProcessManager } from "./process-manager.js";
import type { LocalAgentTransport } from "./transports/transport.js";

export type LocalAgentRuntimeOptions = {
  service: ConnectionService;
  processManager: ProcessManager;
  /** 每个 adapter 的传输（真实实现绑定回环/stdio；测试注入 fake）。 */
  transports: Record<string, LocalAgentTransport>;
  /** 准入门禁：停用/draining 后返回 false，拒绝新回合（design D9）。缺省允许。 */
  admission?: () => boolean;
  /** 受控 MCP 工具 endpoint（回环）。 */
  mcpEndpoint?: { name: string; url: string };
  /** 进程启动参数（按 adapter；不含任意 shell 串）。 */
  argsFor: (adapterId: string) => readonly string[];
  tools?: ApplicationToolDelegationFacade;
  logger?: (event: Record<string, unknown>) => void;
  onGeneratedImage?: (image: { savedPath: string; codexHome: string }) => void;
  /**
   * 组内回合发送前，按用户原文点名的图片标题读出字节。
   * 失败或没有命中时返回空，回合照常进行。
   */
  resolveMentionedImages?: (input: {
    owner: string;
    canvasId: string;
    rootGroupId: string;
    prompt: string;
  }) => Promise<{ images: readonly AgentImageInput[]; note: string } | undefined>;
};

/** 本机来源能力：需要工具的执行由宿主 grant 门禁；讨论只读。 */
function capabilitiesFor(): AgentConnectionCapabilities {
  return { textDelivery: ASSISTANT_CANDIDATE_CAPABILITIES, discussion: true, imageInput: false, tools: true, structuredResult: false, cancel: true, resume: true, targets: ["model3d", "world", "canvas-group"] };
}

/** 原生线程不可恢复时，仍把宿主账本中的合法历史交给续聊回合。 */
function buildDiscussionPrompt(
  history: ReadonlyArray<AgentAdapterRunInput["history"][number]>,
  prompt: string,
): string {
  if (history.length === 0) return prompt;
  const lines = ["以下是本对话之前的消息，仅作为上下文参考："];
  for (const message of history) {
    lines.push(`${message.role === "user" ? "用户" : "助手"}：${message.content}`);
  }
  lines.push("", `用户：${prompt}`);
  return lines.join("\n");
}

/**
 * 经宿主 grant facade 签发本轮 grant（仅在目标执行且宿主配置了工具委托时）。
 *
 * 明确用宿主签发 token（不伪造）；失败时不注入工具面（宁可少做，不越权）。
 */
type ToolGrantOutcome = { token: string } | { token: null; message: string };

async function issueToolGrant(
  facade: ApplicationToolDelegationFacade | undefined,
  input: AgentAdapterRunInput,
  tools: readonly string[]
): Promise<ToolGrantOutcome> {
  if (!facade) return { token: null, message: "宿主未配置工具委托" };
  if (input.intent.action === "discuss" && !input.prepared?.workspace) return { token: null, message: "讨论回合不需要工具授权" };
  try {
    const grant = await facade.issue({
      delegation: { subject: input.owner, authLevel: "authenticated" },
      workId: input.requestId,
      canvasId: input.canvasId,
      nodeId: input.intent.nodeId ?? "",
      ...(input.intent.action !== "discuss" ? { mode: input.intent.mode } : {}),
      ...(input.intent.cameraId ? { cameraId: input.intent.cameraId } : {}),
      ...(input.intent.action !== "discuss" && input.intent.worldScope ? { worldScope: input.intent.worldScope } : {}),
            ...(input.intent.action !== "discuss" && input.intent.worldScope?.kind === "scene-area" ? { allowSceneAreaExpansion: input.intent.allowSceneAreaExpansion === true } : {}),
      ...(input.intent.mode === "canvas-group" && input.intent.expectedContentHash?.startsWith("group-epoch:")
        ? { expectedScopeEpoch: Number(input.intent.expectedContentHash.slice("group-epoch:".length)) }
        : {}),
      tools
    });
    return { token: grant.token };
  } catch (error) {
    // 授权失败不能静默成“未取得授权”：保留目标模式与真实原因，便于定位范围/占地问题。
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[local-agent] tool grant issue failed", {
      mode: input.intent.mode,
      nodeId: input.intent.nodeId,
      worldScope: input.intent.worldScope,
      code: (error as { code?: unknown })?.code,
      message
    });
    return { token: null, message };
  }
}

const ADAPTER_CAPS: AgentAdapterCapabilities = { discussion: true, targets: ["model3d", "world", "canvas-group"], tools: true, models: "remote" };

/** 旧目录只有 reasoningEfforts 时补齐统一能力对象；修订号覆盖目录事实。 */
function catalogSnapshot(models: AgentModelView[]): AgentCatalogSnapshot {
  const normalized = models.map((model) => {
    const reasoning = model.reasoning ?? reasoningCapabilityOf(model);
    return { ...model, reasoning };
  });
  return {
    models: normalized,
    capabilityRevision: agentReasoningRevision(...normalized.map((model) => `${model.id}:${model.reasoning?.revision ?? ""}`))
  };
}

export function createLocalAgentDescriptors(): Record<string, ConnectionDescriptor> {
  const descriptors: Record<string, ConnectionDescriptor> = {};
  for (const adapter of LOCAL_AGENT_ADAPTERS) {
    descriptors[adapter.adapterId] = {
      describe: ({ record }) => {
        // 目录快照里保留了模型级 reasoning 事实；连接视图必须与 adapter catalog 给出同一份
        // 档位，否则受理回合时会以「模型未开放此思考强度」拒绝所有显式选择。
        const catalog = record.modelCatalog ? modelCatalogForRecord(record) : undefined;
        const models = catalog
          ? catalog.models.map((model) => {
            const efforts = model.reasoning.state === "supported" ? (model.reasoning.efforts ?? []).map((option) => option.id) : [];
            return {
              id: model.id,
              label: model.label ?? model.id,
              source: "user-provided" as const,
              accountAuthorized: false,
              reasoning: model.reasoning,
              ...(efforts.length ? { reasoningEfforts: efforts } : {})
            };
          })
          // 不在连接描述里伪造 `app-server-default`：它不是 App Server 的真实模型 id，提交后会被
          // 上游拒绝。用户手填过的模型作为 user-provided 保留；没有时交给 adapter 读取真实目录。
          : (record.models ?? []).map((id) => ({ id, label: id, source: "user-provided" as const, accountAuthorized: false }));
        return {
          name: localAgentConnectionName(adapter.adapterId, record.name),
          capabilities: capabilitiesFor(),
          models,
          // 旧记录还没有目录快照时不冻结修订号，等首次目录读取写回真实能力后再参与失效判断。
          ...(catalog ? { capabilityRevision: catalog.revision } : {}),
          // 本机来源的 credential 证据来自**真实探测/登录状态**（local-login），不来自 secrets；
          // 不在这里写死 status（否则会覆盖 record.lastStatus）。未探测登录前给出可读原因。
          // 本地连接只表示用户选择了该工具；真正的进程、登录和模型检查在首次使用时完成。
          required: [],
          ...(record.lastStatus?.credential.state === "ready" ? {} : { reason: "尚未确认本机工具配置或账号；执行时会启动专用进程并核对" })
        };
      }
    };
  }
  return descriptors;
}

export function createLocalAgentConversationAdapter(adapter: LocalAgentAdapterDescriptor, options: LocalAgentRuntimeOptions): AgentConversationAdapter {
  // 本进程内已落定终态（供 query 核对；不缓存隐式推理）。
  const authorization = async (input: { owner: string }): Promise<AgentAdapterAuthState> => {
    const connections = await options.service.list(input.owner);
    const mine = connections.filter((record) => record.adapterId === adapter.adapterId);
    if (mine.length === 0) return "disconnected";
    // 本机登录状态：仅当最近真实探测证明登录就绪才 ready。
    for (const record of mine) {
      if (record.lastStatus?.credential.state === "ready" && record.lastStatus.transport.state === "ready") return "ready";
    }
    return "disconnected";
  };

  const models = async (input: { owner: string }): Promise<AgentCatalogSnapshot> => {
    const connections = await options.service.list(input.owner);
    const mine = connections.filter((record) => record.adapterId === adapter.adapterId);
    if (mine.length === 0) return catalogSnapshot([]);

    // 手填/历史模型先进入目录；真实上游目录成功时按 id 覆盖展示名，失败仍保留原选择。
    const catalog = new Map<string, AgentModelView>();
    for (const record of mine) {
      for (const model of record.models ?? []) catalog.set(model, { id: model, label: model });
    }

    const transport = options.transports[adapter.adapterId];
    if (!transport?.models) return catalogSnapshot([...catalog.values()]);

    // 目录读取使用该来源的第一条连接；模型目录属于工具/账号而不是某条 UI 连接，
    // 启动的仍是专用进程，不读取或修改用户现有工具配置。
    const record = mine[0]!;
    try {
      const probe = await options.processManager.probe(adapter.adapterId);
      if (!probe.ok) return { ...catalogSnapshot([...catalog.values()]), error: probe.message };
      const identity = { adapterId: adapter.adapterId, owner: input.owner, connectionId: record.connectionId };
      const ensureCatalog = () => options.processManager.ensure({
        adapterId: adapter.adapterId,
        owner: input.owner,
        connectionId: record.connectionId,
        args: options.argsFor(adapter.adapterId),
        kind: adapter.transport === "stdio-jsonrpc" ? "stdio" : "http"
      });
      const readCatalog = async () => {
        const handle = await ensureCatalog();
        return transport.models!({ configDir: handle.configDir, workDir: handle.workDir, loopbackUrl: handle.loopbackUrl, httpHeaders: handle.httpHeaders, stdio: handle.stdio ?? null });
      };
      let snapshot = await readCatalog();
      if (adapter.adapterId === "codex-appserver" && snapshot.error?.includes("Already initialized")) {
        await options.processManager.stop(identity);
        snapshot = await readCatalog();
      }
      for (const model of snapshot.models) catalog.set(model.id, model);
      const snapshotCatalog = catalogSnapshot([...catalog.values()]);
      // 目录读取成功证明传输可用：清掉上次运行留下的 transport 失败证据；账号/模型权限仍由
      // credential/modelAccess 证据单独表达，不能因目录成功就宣称可生成。
      if (!snapshot.error || snapshot.models.length > 0) {
        await options.service
          .setStatus({
            owner: input.owner,
            connectionId: record.connectionId,
            patch: { transport: { state: "ready", checkedAt: new Date().toISOString() } }
          })
          .catch(() => undefined);
        // 把真实目录写回同一条连接记录：连接视图必须携带同一份模型级思考档位，否则受理回合
        // 时会把合法的显式强度当成未开放。目录不是用户配置，不推进 configRevision。
        try {
          await options.service.setModelCatalog?.({ owner: input.owner, connectionId: record.connectionId, models: snapshotCatalog.models });
        } catch { /* 快照写回失败不阻止本次目录读取；下次刷新会重试。 */ }
      }
      return {
        ...snapshotCatalog,
        ...(snapshot.error && catalog.size === 0 ? { error: snapshot.error } : {})
      };
    } catch (error) {
      return {
        ...catalogSnapshot([...catalog.values()]),
        error: error instanceof Error ? error.message : "本机来源模型目录读取失败"
      };
    }
  };

  const runInner = async (input: AgentAdapterRunInput): Promise<AgentAdapterRunOutcome> => {
    // 停用/排空后拒绝新回合（已接受回合由宿主 draining 结算；design D9）。
    if (options.admission && !options.admission()) {
      return { status: "failed", error: { code: "extension-disabled", message: "本机来源已停用或正在排空，拒绝新回合" } };
    }
    const connectionId = input.connection?.connectionId;
    if (!connectionId) return { status: "failed", error: { code: "connection-unavailable", message: "本回合未冻结来源连接" } };
    const record = await options.service.get(input.owner, connectionId);
    if (!record || record.adapterId !== adapter.adapterId || input.connection?.adapterId !== adapter.adapterId || record.configRevision !== input.connection.configRevision || record.credentialEpoch !== input.connection.credentialEpoch) return { status: "failed", error: { code: "connection-unavailable", message: "连接不存在、无权访问或版本已变更" } };
    if (input.candidate && (input.intent.action !== "discuss" || input.candidate.images.length > 12)) return { status: "failed", error: { code: "capability-unsupported", message: "素材生成必须使用独立的无工具回合，最多 12 张图片" } };
    const transport = options.transports[adapter.adapterId];
    if (!transport) return { status: "failed", error: { code: "runtime-missing", message: `未安装 ${adapter.label} 所需运行时` } };

    const probe = await transport.probe();
    if (!probe.ok) {
      await options.service.setStatus({ owner: input.owner, connectionId, patch: { transport: { state: "unavailable", checkedAt: new Date().toISOString(), reason: probe.message } } });
      return { status: "failed", error: { code: probe.code, message: probe.message } };
    }

    const discussion = input.intent.action === "discuss";
    // 通道只消费宿主准备好的角色回合；新回合没有准备身份时在发送前拒绝。
    const prepared = input.prepared;
    if (!prepared) {
      return { status: "failed", error: { code: "role-not-found", message: "本回合没有宿主准备的角色请求，拒绝从用户文字推断角色" } };
    }
    const toolNames = prepared.tools;
    // 发送前能力预检：本机来源不声明图片/结构化结果，显式引用在发送前拒绝。
    const preflight = preflightInput({
      capabilities: capabilitiesFor(),
      wantTools: toolNames.length > 0,
      imageCount: input.intent.references?.filter((reference) => reference.kind === "asset").length ?? 0,
      wantStructuredResult: false
    });
    if (!preflight.ok) return { status: "failed", error: { code: preflight.code, message: preflight.message } };
    // 目标回合必须拿到真实工具面与受控 MCP 入口；缺失时在启动进程/推理前失败，
    // 不能把“模型看不到工具”伪装成一次成功但未修改的回复。
    if (toolNames.length > 0) {
      if (!options.tools) {
        return { status: "failed", error: { code: "capability-unsupported", message: "宿主未配置工具委托，不能执行目标动作" } };
      }
      if (!options.mcpEndpoint) {
        return { status: "failed", error: { code: "capability-unsupported", message: "未配置受控 MCP 工具入口，不能执行目标动作" } };
      }
    }
    if (input.intent.reasoningEffort && !adapter.supportsReasoningEffort) return { status: "failed", error: { code: "capability-unsupported", message: "此本机工具未开放思考强度配置，请使用默认设置" } };
    const toolGrant = await issueToolGrant(options.tools, input, toolNames);
    const toolToken = toolGrant.token;
    if (toolNames.length > 0 && !toolToken) {
      return { status: "failed", error: { code: "capability-unsupported", message: `本轮未取得画布工具授权：${"message" in toolGrant ? toolGrant.message : "授权不可用"}` } };
    }
    const observation = createTurnObserver();
    const toolCalls: string[] = [];
    let successfulWrite = false;
    let imageImported = false;
    let toolFailure: string | undefined;
    const readTools = new Set(AGENT_READ_ONLY_TOOLS);

    // 工具面变化必须切换原生会话：OpenCode/App Server 的 MCP 工具目录在会话内是冻结的，
    // 重用旧会话会让新授权的工具（例如导演区动画）永远不可见。
    // 原生上下文始终包含冻结的角色、修订与准备摘要。
    const context = nativeContextFor(input, `${adapter.adapterId}:1:${[...toolNames].sort().join(",")}`);
    const resourceKey = nativeContextKey(input.owner, connectionId, context);
    try {
      const handle = await options.processManager.ensure({
        adapterId: adapter.adapterId,
        owner: input.owner,
        connectionId: resourceKey,
        requestId: input.requestId,
        args: options.argsFor(adapter.adapterId),
        kind: adapter.transport === "stdio-jsonrpc" ? "stdio" : "http"
      });
      const binding = input.candidate ? null : await options.service.resolveNativeBinding({ owner: input.owner, connectionId, context });
      const mentioned = input.candidate || input.intent.mode !== "canvas-group" || !input.intent.nodeId
        ? undefined
        : await options.resolveMentionedImages?.({
          owner: input.owner,
          canvasId: input.canvasId,
          rootGroupId: input.intent.nodeId,
          prompt: input.intent.prompt
        }).catch((error: unknown) => {
          options.logger?.({ event: "reference-image-resolve-failed", message: error instanceof Error ? error.message : String(error) });
          return undefined;
        });
      const roleText = preparedPromptText(prepared);
      const promptBody = buildDiscussionPrompt(binding ? [] : input.history, roleText);
      const result = await transport.run({
        configDir: handle.configDir,
        workDir: handle.workDir,
        loopbackUrl: handle.loopbackUrl,
        httpHeaders: handle.httpHeaders,
        stdio: handle.stdio ?? null,
        model: input.intent.model ?? record.models?.[0] ?? "",
        ...(input.intent.reasoningEffort ? { reasoningEffort: input.intent.reasoningEffort } : {}),
        prompt: mentioned ? `${promptBody}\n\n${mentioned.note}` : promptBody,
        ...(input.candidate
          ? {
              images: input.candidate.images,
              // 候选输出契约来自角色定义；通道不使用另一份业务 schema。
              outputSchema: prepared.output.kind === "candidate" ? prepared.output.schema : undefined
            }
          : input.images?.length ? { images: input.images }
          : mentioned ? { images: mentioned.images } : {}),
        allowedTools: toolNames,
        nativeCapabilities: prepared.nativeCapabilities,
        ...(options.onGeneratedImage ? { onGeneratedImage: options.onGeneratedImage } : {}),
        toolToken,
        mcpEndpoint: toolNames.length > 0 && toolToken && options.mcpEndpoint ? options.mcpEndpoint : null,
        turnRequestId: input.requestId,
        resumeNativeId: binding?.nativeId ?? null,
        signal: input.signal,
        onEvent: async (event) => {
          // MCP 客户端在做资源能力探测（resources/list、resources/templates/list）时
          // 也会以工具事件形态上报；它们不是角色工具，也不应污染本回合的失败状态。
          if (event.type === "tool-started" && ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(event.tool)) return;
          if (event.type === "tool-completed" && ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(event.tool)) return;
          if (event.type === "tool-started") {
            // 工具事件是观察，不是授权计数：MCP 入口仍然逐次校验范围与撤销状态。
            observation.noteToolCall();
            if (!toolNames.includes(event.tool)) {
              toolFailure = "tool-not-allowed";
              input.emit({ type: "tool-completed", tool: event.tool, ok: false, summary: toolFailure, ...(event.callId ? { callId: event.callId } : {}) });
              return;
            }
            toolCalls.push(event.tool);
          }
          if (event.type === "tool-completed" && toolNames.includes(event.tool)) {
            if (event.ok === false) toolFailure = event.summary ?? "画布工具执行失败";
            if (event.ok === true && !event.tool.startsWith("workspace_") && !readTools.has(event.tool)) successfulWrite = true;
            if (event.tool === "import_generated_image" && event.ok === true) imageImported = true;
          }
          input.emit(event);
        },
        onEvidence: (evidence) => {
          const checkedAt = new Date().toISOString();
          void options.service.setStatus({
            owner: input.owner,
            connectionId,
            patch: {
              ...(evidence.transport ? { transport: { state: evidence.transport, checkedAt, ...(evidence.reason ? { reason: evidence.reason } : {}) } } : {}),
              ...(evidence.credential ? { credential: { state: evidence.credential, checkedAt, ...(evidence.reason ? { reason: evidence.reason } : {}) } } : {})
            }
          });
        }
      });

      if (!result.ok) {
        // MCP 工具面不可用是 tools 证据，模型不可用/无权限是 modelAccess 证据，都不是传输故障；避免把整个连接误标为不可连接。
        if (result.code === "tools-unavailable") {
          await options.service.setStatus({ owner: input.owner, connectionId, patch: { tools: { state: "unavailable", checkedAt: new Date().toISOString(), reason: result.message } } });
        } else if (result.code === "model-access-denied") {
          await options.service.setStatus({ owner: input.owner, connectionId, patch: { modelAccess: { state: "unavailable", checkedAt: new Date().toISOString(), reason: result.message } } });
        } else if (result.code !== "cancelled") {
          await options.service.setStatus({ owner: input.owner, connectionId, patch: { transport: { state: "unavailable", checkedAt: new Date().toISOString(), reason: result.message } } });
        }
        return { status: result.code === "cancelled" ? "cancelled" : "failed", error: { code: result.code, message: result.message } };
      }
      if (input.signal.aborted) return { status: "cancelled" };
      if (input.candidate) {
        const current = await options.service.get(input.owner, connectionId);
        if (!current || current.configRevision !== record.configRevision || current.credentialEpoch !== record.credentialEpoch || (options.admission && !options.admission())) return { status: "failed", error: { code: "connection-unavailable", message: "助手连接已变更，结果未采用" } };
        if (toolFailure) return { status: "failed", error: { code: "capability-unsupported", message: "素材生成不允许调用工具" } };
      }
      if (result.nativeId && input.candidate === undefined) {
        await options.service.setNativeBinding({ owner: input.owner, connectionId, context, native: { nativeId: result.nativeId, credentialEpoch: record.credentialEpoch, updatedAt: new Date().toISOString() } });
      }
      if ((result.generatedImagePaths?.length ?? 0) > 0 && !prepared.nativeCapabilities.includes("generate-image")) {
        return { status: "failed", error: { code: "capability-unsupported", message: "本角色没有开启内建生图，拒绝采用生成的图片" } };
      }
      if (!discussion) {
        const imageFailure = generatedImageImportFailure(result.generatedImagePaths?.length ?? 0, imageImported);
        if (imageFailure) return { status: "failed", error: imageFailure };
      }
      if (!discussion && toolNames.length > 0 && !successfulWrite) return { status: "failed", error: { code: "canvas-not-modified", message: toolFailure ?? "推理结束，但没有成功的画布写入回执" } };
      return result.outcome;
    } catch (error) {
      // 停用/回收时进程不可用：明确失败，不假装成功。
      return { status: "failed", error: { code: "transport-unavailable", message: error instanceof Error ? error.message : "本机来源运行失败" } };
    } finally {
      if (input.candidate) await options.processManager.stop({ adapterId: adapter.adapterId, owner: input.owner, connectionId: resourceKey });
    }
  };

  const run = async (input: AgentAdapterRunInput): Promise<AgentAdapterRunOutcome> => {
    let outcome;
    try { outcome = await runInner(input); } finally { options.tools?.revoke(input.requestId, { subject: input.owner, authLevel: "authenticated" }); }
    const reasoning = input.intent.reasoningEffort
      ? { requested: input.intent.reasoningEffort, applied: outcome.status === "succeeded" || outcome.status === "partial" }
      : { applied: "provider-default" as const };
    return { ...outcome, reasoning: outcome.reasoning ?? reasoning };
  };

  return {
    id: adapter.adapterId,
    capabilities: () => ({ ...ADAPTER_CAPS, nativeCapabilities: adapter.adapterId === "codex-appserver" ? ["generate-image"] : [], textDelivery: ASSISTANT_CANDIDATE_CAPABILITIES, candidateGeneration: ASSISTANT_CANDIDATE_CAPABILITIES }),
    authorization,
    models,
    run
  };
}

export { LOCAL_AGENT_PLUGIN_ID };
