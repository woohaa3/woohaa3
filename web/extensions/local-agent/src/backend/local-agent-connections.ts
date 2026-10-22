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
import type {
  AgentAdapterAuthState,
  AgentAdapterRunInput,
  AgentAdapterRunOutcome,
  AgentAdapterCapabilities,
  AgentCatalogSnapshot,
  AgentModelView,
  AgentConnectionCapabilities,
  AgentConversationAdapter
} from "@woohaa3/contracts";
import { ASSISTANT_CANDIDATE_CAPABILITIES, createTurnBudget, createTurnOutcomeJournal, preflightInput, type ConnectionDescriptor, type ConnectionService } from "@woohaa3/agent-connections";
import type { ApplicationToolDelegationFacade } from "@woohaa3/contracts";
import { LOCAL_AGENT_ADAPTERS, LOCAL_AGENT_PLUGIN_ID, type LocalAgentAdapterDescriptor } from "../shared.js";
import type { ProcessManager } from "./process-manager.js";
import type { LocalAgentTransport } from "./transports/transport.js";
import { buildTargetPrompt } from "./target-prompt.js";
import { localAgentToolsForMode } from "./tool-scope.js";

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
};

/** 本机来源能力：需要工具的执行由宿主 grant 门禁；讨论只读。 */
function capabilitiesFor(): AgentConnectionCapabilities {
  return { discussion: true, imageInput: false, tools: true, structuredResult: false, cancel: true, resume: true };
}

/**
 * 经宿主 grant facade 签发本轮 grant（仅在目标执行且宿主配置了工具委托时）。
 *
 * 明确用宿主签发 token（不伪造）；失败时不注入工具面（宁可少做，不越权）。
 */
async function issueToolGrant(
  facade: ApplicationToolDelegationFacade | undefined,
  input: AgentAdapterRunInput,
  tools: readonly string[]
): Promise<string | null> {
  if (!facade || input.intent.action === "discuss") return null;
  try {
    const grant = await facade.issue({
      delegation: { subject: input.owner, authLevel: "authenticated" },
      workId: input.requestId,
      canvasId: input.canvasId,
      nodeId: input.intent.nodeId ?? "",
      mode: input.intent.mode,
      ...(input.intent.mode === "canvas-group" ? { expectedScopeEpoch: Number(input.intent.expectedContentHash?.slice("group-epoch:".length)) } : {}),
      ...(input.intent.cameraId ? { cameraId: input.intent.cameraId } : {}),
      ...(input.intent.clipId ? { clipId: input.intent.clipId } : {}),
      ...(input.intent.itemId ? { itemId: input.intent.itemId } : {}),
      tools,
      maxCalls: 24
    });
    return grant.token;
  } catch {
    return null;
  }
}

const ADAPTER_CAPS: AgentAdapterCapabilities = { discussion: true, targets: ["model3d", "film-set", "camera"], tools: true, models: "remote" };

export function createLocalAgentDescriptors(): Record<string, ConnectionDescriptor> {
  const descriptors: Record<string, ConnectionDescriptor> = {};
  for (const adapter of LOCAL_AGENT_ADAPTERS) {
    descriptors[adapter.adapterId] = {
      describe: ({ record }) => ({
        capabilities: capabilitiesFor(),
        // 不在连接描述里伪造 `app-server-default`：它不是 App Server 的真实模型 id，提交后会被
        // 上游拒绝。用户手填过的模型作为 user-provided 保留；没有时交给 adapter 读取真实目录。
        models:
          record.models && record.models.length > 0
            ? record.models.map((id) => ({ id, label: id, source: "user-provided" as const, accountAuthorized: false }))
            : [],
        // 本机来源的 credential 证据来自**真实探测/登录状态**（local-login），不来自 secrets；
        // 不在这里写死 status（否则会覆盖 record.lastStatus）。未探测登录前给出可读原因。
        required: ["transport", "credential"],
        ...(record.lastStatus?.credential.state === "ready" ? {} : { reason: "尚未确认本机工具配置或账号；执行时会启动专用进程并核对" })
      })
    };
  }
  return descriptors;
}

export function createLocalAgentConversationAdapter(adapter: LocalAgentAdapterDescriptor, options: LocalAgentRuntimeOptions): AgentConversationAdapter {
  // 本进程内已落定终态（供 query 核对；不缓存隐式推理）。
  const journal = createTurnOutcomeJournal();
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
    if (mine.length === 0) return { models: [] };

    // 手填/历史模型先进入目录；真实上游目录成功时按 id 覆盖展示名，失败仍保留原选择。
    const catalog = new Map<string, AgentModelView>();
    for (const record of mine) {
      for (const model of record.models ?? []) catalog.set(model, { id: model, label: model });
    }

    const transport = options.transports[adapter.adapterId];
    if (!transport?.models) return { models: [...catalog.values()] };

    // 目录读取使用该来源的第一条连接；模型目录属于工具/账号而不是某条 UI 连接，
    // 启动的仍是专用进程，不读取或修改用户现有工具配置。
    const record = mine[0]!;
    try {
      const probe = options.processManager.probe(adapter.adapterId);
      if (!probe.ok) return { models: [...catalog.values()], error: probe.message };
      const handle = await options.processManager.ensure({
        adapterId: adapter.adapterId,
        owner: input.owner,
        connectionId: record.connectionId,
        args: options.argsFor(adapter.adapterId),
        kind: adapter.transport === "stdio-jsonrpc" ? "stdio" : "http"
      });
      const snapshot = await transport.models({
        configDir: handle.configDir,
        workDir: handle.workDir,
        loopbackUrl: handle.loopbackUrl,
        httpHeaders: handle.httpHeaders,
        stdio: handle.stdio ?? null
      });
      for (const model of snapshot.models) catalog.set(model.id, model);
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
      }
      return {
        models: [...catalog.values()],
        ...(snapshot.error && catalog.size === 0 ? { error: snapshot.error } : {})
      };
    } catch (error) {
      return {
        models: [...catalog.values()],
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
    // 发送前能力预检：本机来源不声明图片/结构化结果，显式引用在发送前拒绝。
    const preflight = preflightInput({
      capabilities: capabilitiesFor(),
      wantTools: !discussion,
      imageCount: input.intent.references?.filter((reference) => reference.kind === "asset").length ?? 0,
      wantStructuredResult: false
    });
    if (!preflight.ok) return { status: "failed", error: { code: preflight.code, message: preflight.message } };
    // 目标回合必须拿到真实工具面与受控 MCP 入口；缺失时在启动进程/推理前失败，
    // 不能把“模型看不到工具”伪装成一次成功但未修改的回复。
    if (!discussion) {
      if (!options.tools) {
        return { status: "failed", error: { code: "capability-unsupported", message: "宿主未配置工具委托，不能执行目标动作" } };
      }
      if (!options.mcpEndpoint) {
        return { status: "failed", error: { code: "capability-unsupported", message: "未配置受控 MCP 工具入口，不能执行目标动作" } };
      }
    }
    if (input.intent.reasoningEffort && adapter.adapterId !== "codex-appserver") return { status: "failed", error: { code: "capability-unsupported", message: "此本机工具未开放思考强度配置，请使用默认设置" } };
    const toolNames = discussion ? [] : localAgentToolsForMode(input.intent.mode ?? "model3d");
    const toolToken = await issueToolGrant(options.tools, input, toolNames);
    if (!discussion && !toolToken) {
      return { status: "failed", error: { code: "capability-unsupported", message: "本轮未取得画布工具授权，不能执行目标动作" } };
    }
    const budget = createTurnBudget({});
    const toolCalls: string[] = [];
    let successfulWrite = false;
    let toolFailure: string | undefined;
    const readTools = new Set(["get_model_api", "get_model_node", "get_model_statistics", "get_model_cameras", "get_film_set_clips", "get_canvas_capabilities", "get_canvas_graph", "get_canvas_changes", "get_canvas_script_api", "validate_canvas_script", "validate_canvas_plan", "get_canvas_run", "get_node_output"]);

    const context = nativeContextFor(input, `${adapter.adapterId}:1`);
    const resourceKey = nativeContextKey(input.owner, connectionId, context);
    try {
      const handle = await options.processManager.ensure({
        adapterId: adapter.adapterId,
        owner: input.owner,
        connectionId: resourceKey,
        args: options.argsFor(adapter.adapterId),
        kind: adapter.transport === "stdio-jsonrpc" ? "stdio" : "http"
      });
      const binding = input.candidate ? null : await options.service.resolveNativeBinding({ owner: input.owner, connectionId, context });
      const result = await transport.run({
        configDir: handle.configDir,
        workDir: handle.workDir,
        loopbackUrl: handle.loopbackUrl,
        httpHeaders: handle.httpHeaders,
        stdio: handle.stdio ?? null,
        model: input.intent.model ?? record.models?.[0] ?? "",
        ...(input.intent.reasoningEffort ? { reasoningEffort: input.intent.reasoningEffort } : {}),
        prompt: discussion ? input.intent.prompt : buildTargetPrompt(input.intent, input.requestId),
        ...(input.candidate ? { images: input.candidate.images, outputSchema: input.candidate.outputSchema } : {}),
        allowedTools: toolNames,
        toolToken,
        mcpEndpoint: !discussion && toolToken && options.mcpEndpoint ? options.mcpEndpoint : null,
        resumeNativeId: binding?.nativeId ?? null,
        signal: input.signal,
        onEvent: async (event) => {
          if (event.type === "tool-started") {
            if (!budget.useToolCall()) return;
            // Notifications are observations; only the MCP entry consumes the grant.
            if (!toolNames.includes(event.tool)) {
              toolFailure = "tool-not-allowed";
              input.emit({ type: "tool-completed", tool: event.tool, ok: false, summary: toolFailure, ...(event.callId ? { callId: event.callId } : {}) });
              return;
            }
            toolCalls.push(event.tool);
          }
          if (event.type === "tool-completed" && toolNames.includes(event.tool)) {
            if (event.ok === false) toolFailure = event.summary ?? "画布工具执行失败";
            if (event.ok === true && !readTools.has(event.tool)) successfulWrite = true;
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
        // MCP 工具面不可用是 tools 证据，不是传输故障；避免把整个连接误标为不可连接。
        if (result.code === "tools-unavailable") {
          await options.service.setStatus({ owner: input.owner, connectionId, patch: { tools: { state: "unavailable", checkedAt: new Date().toISOString(), reason: result.message } } });
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
      if (result.nativeId && !input.candidate) {
        await options.service.setNativeBinding({ owner: input.owner, connectionId, context, native: { nativeId: result.nativeId, credentialEpoch: record.credentialEpoch, updatedAt: new Date().toISOString() } });
      }
      if (budget.expired()) return { status: "failed", error: { code: "budget-exceeded", message: budget.exceededReason() ?? "超出预算" } };
      if (!discussion && !successfulWrite) return { status: "failed", error: { code: "canvas-not-modified", message: toolFailure ?? "推理结束，但没有成功的画布写入回执" } };
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
    // 记录落定终态供重启/断线核对（不重跑推理；design D6）。
    journal.set(input.requestId, outcome);
    return outcome;
  };

  return {
    id: adapter.adapterId,
    capabilities: () => ({ ...ADAPTER_CAPS, candidateGeneration: ASSISTANT_CANDIDATE_CAPABILITIES, targets: [...ADAPTER_CAPS.targets, ...(options.tools && options.mcpEndpoint ? ["canvas-group" as const] : [])] }),
    authorization,
    models,
    run,
    // 重启/断线后核对：只回答本进程内已落定终态；无记录返回 null（宿主保留既有回执，
    // 不重跑推理；design D6）。
    query: async (input: { owner: string; requestId: string }) => journal.get(input.requestId)
  };
}

export { LOCAL_AGENT_PLUGIN_ID };
