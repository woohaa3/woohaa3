import { sdkSourceFor, sdkSourceProtocol } from "./service-source.js";
/** Fixed framework dispatch. The host ledger owns idempotency; frameworks own inference loops. */
import {
  agentReasoningRevision,
  type AgentConnectionCapabilities, type AgentConnectionModel, type AgentConnectionStatus, type AgentConversationAdapter, type AgentAdapterRunInput,
  type AgentAdapterRunOutcome, type AgentConnectionRuntime, type AgentEngineId, type ApplicationToolDelegationFacade,
  type ApplicationCanvasAuthoringFacade, type ApplicationUserDelegation
} from "@woohaa3/contracts";
import { createEndpointPolicy, createModelTransport, modelCatalogForRecord, nativeContextFor, nativeContextKey, preflightInput, preparedPromptText, type ConnectionService, type ConnectionDescriptor } from "@woohaa3/agent-connections";
import { SDK_AGENT_ADAPTERS, SDK_AGENT_PLUGIN_ID, findSdkAgentAdapter, sdkEngineForAdapter, type SdkAgentAdapterDescriptor } from "../shared.js";
import { createAgentSdkAdapter, type AgentSdkTransport } from "./adapters/agent-sdk-adapter.js";
import { createFixedEngineRuntime, type FixedEngineRuntime } from "./fixed-engine-runtime.js";
import { createMcpTurnGateway } from "./mcp-turn-gateway.js";
import { projectReasoningCapability } from "./adapters/reasoning.js";
import { ASSISTANT_CANDIDATE_CAPABILITIES } from "@woohaa3/agent-connections";

export type SdkAgentRuntimeOptions = {
  service: Pick<ConnectionService, "get" | "list" | "readCredential" | "credentialConfigured" | "setRuntimeProbe" | "resolveNativeBinding" | "setNativeBinding" | "setStatus">;
  executor?: import("@woohaa3/contracts").ApplicationExtensionExecutorFacade;
  serviceConnections?: import("@woohaa3/contracts").ApplicationServiceConnectionFacade;
  admission?: () => boolean;
  shutdownSignal?: AbortSignal;
  inFlight?: Set<Promise<unknown>>;
  /** 部署允许的自定义 endpoint host（纯 HTTP API；未指定或包含 * 时不限制）。 */
  allowedHosts?: readonly string[];
  allowHttp: boolean;
  mcpServerUrl?: string;
  agentSdkDirs?: { workspaceDir: string; configDir: string };
  fetchImpl?: typeof globalThis.fetch;
  transports?: Partial<Record<AgentEngineId, AgentSdkTransport>>;
  runtime?: FixedEngineRuntime;
  tools?: Pick<ApplicationToolDelegationFacade, "issue" | "revoke">;
  authoring?: Pick<ApplicationCanvasAuthoringFacade, "readNode">;
  ownerDelegation?: (owner: string) => ApplicationUserDelegation;
  logger?: (event: Record<string, unknown>) => void;
};

/** 目录与执行共用的模型能力投影：只保留 adapter 能映射的档位。 */
export function sdkModelViews(adapterId: string, record: Parameters<typeof modelCatalogForRecord>[0]): AgentConnectionModel[] {
  const engine = sdkEngineForAdapter(adapterId)?.engine;
  if (!engine) return [];
  const catalog = modelCatalogForRecord(record);
  return catalog.models.map((model) => {
    const reasoning = projectReasoningCapability(engine, model.reasoning);
    const efforts = reasoning.state === "supported" ? (reasoning.efforts ?? []).map((option) => option.id) : [];
    return {
      id: model.id,
      label: model.label ?? model.id,
      source: "user-provided" as const,
      accountAuthorized: false,
      reasoning,
      ...(efforts.length ? { reasoningEfforts: efforts } : {})
    };
  });
}

/**
 * 按真实结束原因报告截断/中止，并保留已经确认的分段写入事实。
 *
 * 这类结束在运行时协议里不是错误（dsh 的 `turn/end: max-tokens`），但可能已有部分写入；
 * 不单独识别就只能落到「作品更新未确认」，用户看不到真实原因。
 */
export function unwrittenError(finishReason: import("./protocol/model-turn.js").ModelTurnOutcome["finishReason"], hasWrites = false): { code: string; message: string } | undefined {
  const progress = hasWrites ? "已成功提交的修改已保留，请先回读核对，再继续未完成部分" : "本轮没有完成写入，请拆分需求后重试";
  if (finishReason === "length") return { code: "output-truncated", message: `模型输出达到长度上限被截断；${progress}` };
  if (finishReason === "content_filter") return { code: "content-filtered", message: `模型输出被安全策略中止；${progress}` };
  return undefined;
}

export function capabilitiesFor(_adapter: SdkAgentAdapterDescriptor): AgentConnectionCapabilities {
  const engine = sdkEngineForAdapter(_adapter.adapterId)?.engine;
  // DeepSeek Harness runs in a disposable per-turn home/work directory. It returns a
  // session id for diagnostics, but that id cannot be resumed after the directory is
  // removed, so advertising native resume would make target retries silently lose
  // their durable conversation history.
  return { textDelivery: ASSISTANT_CANDIDATE_CAPABILITIES, discussion: true, imageInput: false, tools: true, structuredResult: false, cancel: true, resume: engine !== "dsh-agent-sdk", targets: ["model3d", "world", "canvas-group"] };
}

export function createSdkAgentDescriptors(options: Pick<SdkAgentRuntimeOptions, "allowedHosts" | "allowHttp">): Record<string, ConnectionDescriptor> {
  return Object.fromEntries(SDK_AGENT_ADAPTERS.map((adapter) => [adapter.adapterId, {
    describe: ({ record, credentialConfigured }) => {
      const binding = sdkEngineForAdapter(adapter.adapterId)!;
      const endpointAllowed = createEndpointPolicy({ allowedHosts: options.allowedHosts, allowHttp: options.allowHttp }).check(record.baseUrl ?? adapter.officialBaseUrl).ok &&
        (adapter.allowCustomBaseUrl || !record.baseUrl || record.baseUrl.replace(/\/$/, "") === adapter.officialBaseUrl);
      const unknown = { state: "unknown" as const, checkedAt: null };
      // A pending probe means preparation is in flight: never project it as executable, and never
      // turn it into "unknown" (which callers may treat as an implicit retry).
      const probe = record.runtimeProbe?.version === `${binding.engine}@${binding.version}:1` ? record.runtimeProbe.evidence : unknown;
      const runtime: AgentConnectionRuntime = {
        schemaVersion: 1, apiType: binding.apiType, engine: binding.engine, engineVersion: binding.version,
        dependency: endpointAllowed ? probe : { state: "unavailable", reason: "服务地址不符合当前部署策略，请检查 Base URL" },
        tasks: {
          discussion: record.lastStatus?.modelAccess ?? unknown,
          imageInput: { state: "unavailable", reason: "当前引擎尚未开放图片附件" },
          targetExecution: record.lastStatus?.tools ?? unknown
        }
      };
      const models: AgentConnectionModel[] = sdkModelViews(adapter.adapterId, record);
      const catalog = modelCatalogForRecord(record);
      const catalogRevision = catalog.revision;
      // A saved Key on an allowed endpoint makes the HTTP transport attemptable. This is not a model
      // probe: modelAccess stays unknown, and an explicit failed/unavailable evidence is preserved.
      const transport = record.lastStatus?.transport;
      const transportEvidence = transport && (transport.state === "failed" || transport.state === "unavailable")
        ? transport
        : endpointAllowed && credentialConfigured ? { state: "ready" as const, checkedAt: transport?.checkedAt ?? null } : transport ?? unknown;
      const status: AgentConnectionStatus = { transport: transportEvidence, credential: record.lastStatus?.credential ?? unknown,
        modelAccess: record.lastStatus?.modelAccess ?? unknown, tools: record.lastStatus?.tools ?? unknown };
      // The source projection can reject a saved credential (disabled source or missing
      // protocol binding). Preserve that cause instead of reporting a missing API Key.
      const sourceReason = "reason" in record && typeof record.reason === "string" ? record.reason : undefined;
      const blockedReason = sourceReason ?? (!endpointAllowed ? runtime.dependency.reason
        : runtime.dependency.state === "pending" ? runtime.dependency.reason ?? "正在准备固定 Agent 运行时…"
        : !credentialConfigured ? "尚未保存 API Key"
        : runtime.dependency.state === "unavailable" || runtime.dependency.state === "failed" ? runtime.dependency.reason
        : undefined);
      return { runtime, status, capabilities: capabilitiesFor(adapter), models, capabilityRevision: catalogRevision, ...(catalog.error ? { modelsError: catalog.error } : {}), required: ["credential", "transport"], endpointAllowed,
        ...(blockedReason ? { reason: blockedReason } : {}) };
    }
  } satisfies ConnectionDescriptor]));
}

export function createSdkAgentConversationAdapter(adapter: SdkAgentAdapterDescriptor, options: SdkAgentRuntimeOptions): AgentConversationAdapter {
  const engine = sdkEngineForAdapter(adapter.adapterId)!;
  const runtime = options.runtime ?? (options.agentSdkDirs ? createFixedEngineRuntime(options.agentSdkDirs) : undefined);
  const journal = new Map<string, AgentAdapterRunOutcome>();
  const active = new Map<string, AbortController>();
  const candidateRuns = new Map<string, { controller: AbortController; done: Promise<AgentAdapterRunOutcome> }>();
  const fail = (code: string, message: string): AgentAdapterRunOutcome => ({ status: "failed", error: { code, message } });
  const runInner = async (input: AgentAdapterRunInput): Promise<AgentAdapterRunOutcome> => {
    if (options.admission && !options.admission()) return fail("extension-disabled", "SDK 扩展已停用或正在排空");
    if (input.candidate && (input.intent.action !== "discuss" || input.candidate.images.length > 12)) return fail("capability-unsupported", "素材生成必须使用独立的无工具回合，最多 12 张图片");
    const frozen = input.connection;
    if (!frozen || frozen.adapterId !== adapter.adapterId) return fail("connection-unavailable", "本轮未冻结有效连接");
    const record = await options.service.get(input.owner, frozen.connectionId);
    if (!record || record.adapterId !== adapter.adapterId || record.configRevision !== frozen.configRevision || record.credentialEpoch !== frozen.credentialEpoch) return fail("version-conflict", "连接已更新，请重新读取");
    const baseUrl = record.baseUrl ?? adapter.officialBaseUrl;
    if (!adapter.allowCustomBaseUrl && baseUrl.replace(/\/$/, "") !== adapter.officialBaseUrl) return fail("endpoint-not-allowed", "当前协议不支持此服务地址，请检查 Base URL");
    const endpointPolicy = createEndpointPolicy({ allowedHosts: options.allowedHosts, allowHttp: options.allowHttp });
    const endpointCheck = endpointPolicy.check(baseUrl);
    if (!endpointCheck.ok) return fail(endpointCheck.code, endpointCheck.message);
    const model = input.intent.model ?? record.models?.[0];
    if (!model) return fail("malformed-request", "请明确选择模型");
    const reasoning = sdkModelViews(adapter.adapterId, record).find((entry) => entry.id === model)?.reasoning;
    if (input.intent.reasoningEffort && (reasoning?.state !== "supported" || !(reasoning.efforts ?? []).some((option) => option.id === input.intent.reasoningEffort))) return fail("capability-unsupported", "当前模型未开放此思考强度，请使用默认设置");
    // 通道只消费宿主准备好的角色回合；缺失即拒绝，不从 mode/用户文字推断业务职责。
    const prepared = input.prepared;
    if (!prepared) return fail("role-not-found", "本回合没有宿主准备的角色请求");
    const toolNames = input.intent.action === "discuss" ? [] : prepared.tools;
    const preflight = preflightInput({ capabilities: capabilitiesFor(adapter), wantTools: toolNames.length > 0, imageCount: input.intent.references?.filter((ref) => ref.kind === "asset").length ?? 0, wantStructuredResult: false });
    if (!preflight.ok) return fail(preflight.code, preflight.message);
    const source = options.serviceConnections ? await sdkSourceFor(options.serviceConnections, input.owner, record.connectionId, options.service) : null;
    if (options.serviceConnections && !source) return fail("connection-unavailable", "模型提供商尚未迁移，请重试");
    let credential: { secret: string } | null;
    try {
      credential = source && options.serviceConnections ? await options.serviceConnections.resolve(input.owner, {
        ...source, bindingId: source.bindings.find(binding => binding.extensionId === "sdk-agent" && (binding.consumerId === record.connectionId || record.serviceConnectionId && binding.consumerId === `shared:${sdkSourceProtocol(record.adapterId)}`))?.bindingId ?? "", purpose: "text",
        protocol: sdkSourceProtocol(record.adapterId), modelId: model, endpoint: baseUrl,
      }) : await options.service.readCredential<{ secret: string }>({ owner: input.owner, connectionId: record.connectionId, purpose: "model-api-key" });
    } catch { return fail("version-conflict", "模型提供商或用途已失效，请重新读取"); }
    if (!credential?.secret) return fail("credential-missing", "该连接尚未保存 API Key");
    let transport: AgentSdkTransport;
    try {
      if (!options.transports?.[engine.engine] && !runtime) return fail("runtime-missing", `缺少 ${engine.engine} ${engine.version} 配套运行时，请在设置 → 运行时组件中准备`);
      if (!options.transports?.[engine.engine] && runtime?.prepare) {
        // 准备发生在任何模型传输与工具授权之前；等待同一版本的单飞安装。
        const preparing = await runtime.prepare(engine.engine);
        if (preparing.state !== "ready") {
          await options.service.setRuntimeProbe?.(input.owner, record.connectionId, `${engine.engine}@${engine.version}:1`, { state: "unavailable", checkedAt: new Date().toISOString(), reason: preparing.reason ?? `缺少 ${engine.engine} ${engine.version} 配套运行时` });
          return fail("runtime-missing", preparing.reason ?? `缺少 ${engine.engine} ${engine.version} 配套运行时`);
        }
        await options.service.setRuntimeProbe?.(input.owner, record.connectionId, `${engine.engine}@${engine.version}:1`, { state: "ready", checkedAt: new Date().toISOString() });
      }
      transport = options.transports?.[engine.engine] ?? await runtime!.resolve(engine.engine);
    } catch (error) {
      const reason = error instanceof Error ? error.message : `缺少 ${engine.engine} ${engine.version} 配套运行时`;
      await options.service.setRuntimeProbe?.(input.owner, record.connectionId, `${engine.engine}@${engine.version}:1`, { state: "unavailable", checkedAt: new Date().toISOString(), reason });
      return fail("runtime-missing", reason);
    }
    await options.service.setRuntimeProbe?.(input.owner, record.connectionId, `${engine.engine}@${engine.version}:1`, { state: "ready", checkedAt: new Date().toISOString() });
    if (record.runtimeVersion !== `${engine.engine}@${engine.version}:1`) return fail("migration-required", "连接执行版本尚未升级，请从作品面板重新发起并先核对活动或未知回合");
    const context = nativeContextFor(input, `${engine.engine}@${engine.version}:1`);
    const resourceKey = nativeContextKey(input.owner, record.connectionId, context);
    if (active.has(resourceKey)) return fail("conversation-busy", "前一回合尚未排空");
    const controller = new AbortController(); active.set(resourceKey, controller);
    const abort = () => { options.tools?.revoke(input.requestId, { subject: input.owner, authLevel: "authenticated" }); controller.abort(); };
    input.signal.addEventListener("abort", abort, { once: true });
    options.shutdownSignal?.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted || options.shutdownSignal?.aborted) abort();
    const valid = async () => {
      const current = await options.service.get(input.owner, record.connectionId);
      const currentSource = source && options.serviceConnections ? await options.serviceConnections.get(input.owner, source.serviceConnectionId) : null;
      const sourceValid = !source || !!currentSource && currentSource.enabled && !currentSource.removed && currentSource.configRevision === source.configRevision && currentSource.credentialEpoch === source.credentialEpoch;
      return sourceValid && !controller.signal.aborted && (!options.admission || options.admission()) && current?.configRevision === frozen.configRevision && current.credentialEpoch === frozen.credentialEpoch;
    };
    const trace = (step: string, extra: Record<string, unknown> = {}) => options.logger?.({ event: "sdk-agent-turn-trace", step, connectionId: record.connectionId, action: input.intent.action, model, ...extra });
    let relay: Awaited<ReturnType<typeof createModelTransport>> | undefined;
    let gateway: Awaited<ReturnType<typeof createMcpTurnGateway>> | undefined;
    let stage: "connection" | "target" | "execution" = "connection";
    try {
      relay = await createModelTransport({ apiType: engine.apiType, upstream: baseUrl, apiKey: credential.secret,
        policy: endpointPolicy, valid, signal: controller.signal });
      if (input.intent.action !== "discuss") {
        stage = "target";
        if (!options.tools || !options.mcpServerUrl || !input.intent.nodeId) return fail("capability-unsupported", "目标执行需要受控工具与权威目标");
        if (input.intent.mode === "world" || input.intent.mode === "canvas-group") {
          if (input.intent.mode === "world" && !input.intent.worldScope) return fail("capability-unsupported", "世界目标缺少可信范围选择");
          options.tools.revoke(input.requestId, { subject: input.owner, authLevel: "authenticated" });
          const expectedScopeEpoch = input.intent.mode === "canvas-group" && input.intent.expectedContentHash?.startsWith("group-epoch:")
            ? Number(input.intent.expectedContentHash.slice("group-epoch:".length))
            : undefined;
          const grant = await options.tools.issue({ delegation: options.ownerDelegation?.(input.owner) ?? { subject: input.owner, authLevel: "authenticated" },
            workId: input.requestId, canvasId: input.canvasId, nodeId: input.intent.nodeId, mode: input.intent.mode,
            ...(input.intent.worldScope ? { worldScope: input.intent.worldScope } : {}),
            ...(expectedScopeEpoch !== undefined ? { expectedScopeEpoch } : {}),
            tools: toolNames });
          gateway = await createMcpTurnGateway({ input: { ...input, signal: controller.signal }, upstream: options.mcpServerUrl, grant: grant.token, valid,
            // The issued world context revalidates scope/version/leases on every write.
            validateTarget: async () => valid() });
        } else {
          if (!options.authoring) return fail("capability-unsupported", "目标执行需要受控工具、权威目标及内容版本");
          const targetHash = (target: Awaited<ReturnType<ApplicationCanvasAuthoringFacade["readNode"]>>) =>
            target.ok ? target.modelContentVersion?.contentHash ?? target.snapshotHash : undefined;
          const target = await options.authoring.readNode({ delegation: { subject: input.owner, authLevel: "authenticated" }, canvasId: input.canvasId, nodeId: input.intent.nodeId });
          const frozenHash = targetHash(target);
          if (!target.ok || !frozenHash || (input.intent.expectedContentHash && input.intent.expectedContentHash !== frozenHash)) return fail("version-conflict", "目标内容已变化或不可读取，请重新打开作品");
          const frozenInput = { ...input, intent: { ...input.intent, expectedContentHash: frozenHash } };
          options.tools.revoke(input.requestId, { subject: input.owner, authLevel: "authenticated" });
          const grant = await options.tools.issue({ delegation: options.ownerDelegation?.(input.owner) ?? { subject: input.owner, authLevel: "authenticated" },
            workId: input.requestId, canvasId: input.canvasId, nodeId: input.intent.nodeId, mode: input.intent.mode,
            ...(input.intent.cameraId ? { cameraId: input.intent.cameraId } : {}),
            tools: toolNames });
          gateway = await createMcpTurnGateway({ input: { ...frozenInput, signal: controller.signal }, upstream: options.mcpServerUrl, grant: grant.token, valid,
            validateTarget: async () => {
              const target = await options.authoring!.readNode({ delegation: { subject: input.owner, authLevel: "authenticated" }, canvasId: input.canvasId, nodeId: input.intent.nodeId! });
              return targetHash(target) === frozenHash;
            } });
        }
      }
      stage = "execution";
      trace("gateway-ready", { tools: toolNames.length });
      const native = input.candidate || engine.engine === "dsh-agent-sdk" ? null : await options.service.resolveNativeBinding({ owner: input.owner, connectionId: record.connectionId, context });
      const engineModel = model;
      const sdk = createAgentSdkAdapter({ kind: engine.engine, apiKey: relay.token, modelBaseUrl: relay.baseUrl, resourceKey,
        configDir: options.agentSdkDirs?.configDir ?? "", workspaceDir: options.agentSdkDirs?.workspaceDir ?? "", transport,
        probeRuntime: async () => ({ ok: true }) });
      // Legal host history is replayable when an engine cannot resume or the process restarted.
      const history = (native && input.intent.action !== "discuss" ? [] : input.history).map((message) => `${message.role}: ${message.content}`).join("\n");
      const prompt = (history ? `会话历史：\n${history}\n\n` : "") + preparedPromptText(prepared);
      // 模型自己声明过的工具调用：与网关实际收到的写入次数对比，能区分「模型没写」和「调用没送达」。
      const suggestedTools: string[] = [];
      trace("sdk-start", { engine: engine.engine, engineModel, effort: input.intent.reasoningEffort ?? null, tools: gateway?.tools?.length ?? 0 });
      const result = await sdk.run({ model: engineModel, prompt, onToolCall: (call) => { suggestedTools.push(call.name); }, ...(input.intent.reasoningEffort ? { reasoningEffort: input.intent.reasoningEffort } : {}), signal: controller.signal, tools: gateway?.tools ?? [],
        ...(input.candidate
          ? { images: input.candidate.images, outputSchema: prepared.output.kind === "candidate" ? prepared.output.schema : input.candidate.outputSchema }
          : input.images?.length ? { images: input.images }
          : {}),
        ...(gateway ? { toolToken: gateway.token, mcpEndpoint: { name: "woohaa", url: gateway.url, bearerToken: gateway.token } } : {}),
        // Discussion cannot resurrect a thread carrying a previous target grant.
        ...(native && input.intent.action !== "discuss" ? { resumeNativeId: native.nativeId } : {}),
        onText: (content, meta) => input.emit({
          type: "message",
          role: "assistant",
          content,
          ...(meta ? { delivery: meta.delivery } : {}),
          ...(meta?.streamId ? { streamId: meta.streamId } : {})
        }) });
      await gateway?.drain();
      const receipts = gateway?.receipts ?? [];
      trace("sdk-done", { ok: result.ok, finishReason: result.ok ? result.outcome.finishReason : result.code, textLength: result.ok ? result.outcome.assistantText.length : 0, toolCalls: gateway?.receivedTools ?? [], receipts: receipts.length });
      const receipt = { kind: "canvas-commands", commands: receipts };
      const reasoning = result.reasoning;
      if (!result.ok) return { status: receipts.length ? "partial" : result.code === "cancelled" ? "cancelled" : "failed", error: { code: result.code, message: result.message }, ...(reasoning ? { reasoning } : {}), ...(receipts.length ? { receipt } : {}) };
      if (input.candidate && !await valid()) return controller.signal.aborted ? { status: "cancelled" } : fail("version-conflict", "助手连接已变更，结果未采用");
      await options.service.setStatus({ owner: input.owner, connectionId: record.connectionId, patch: { transport: { state: "ready", checkedAt: new Date().toISOString() }, modelAccess: { state: "ready", checkedAt: new Date().toISOString() }, ...(receipts.length ? { tools: { state: "ready" as const, checkedAt: new Date().toISOString() } } : {}) } });
      const rememberNative = async () => {
        // A native id is useful only after a successful discussion or a target turn
        // with a proven write receipt. Never bind a read-only/failed target turn:
        // retrying it in the same native thread is a common source of repeated
        // "read context, then stop" responses.
        if (!result.nativeId || input.candidate || engine.engine === "dsh-agent-sdk" || !await valid()) return;
        await options.service.setNativeBinding({ owner: input.owner, connectionId: record.connectionId, context, native: { nativeId: result.nativeId, credentialEpoch: record.credentialEpoch, conversationId: input.conversationId, updatedAt: new Date().toISOString() } });
      };
      if (input.intent.action === "discuss") {
        await rememberNative();
        return { status: "succeeded", assistantText: result.outcome.assistantText, ...(reasoning ? { reasoning } : {}) };
      }
      // 截断不能冒充成功；已确认的分段回执也不能被说成没有写入。
      const attemptedWrites = gateway?.attemptedWrites ?? 0;
      // 只有「模型声明过、网关却从未收到」的调用才算丢失；读工具成功送达不算。
      const delivered = new Set(gateway?.receivedTools ?? []);
      const lostTools = [...new Set(suggestedTools)].filter((name) => !delivered.has(name));
      if (!receipts.length) options.logger?.({ event: "sdk-agent-turn-unwritten", connectionId: record.connectionId, action: input.intent.action, model, finishReason: result.outcome.finishReason, suggestedTools: [...new Set(suggestedTools)], deliveredTools: [...delivered], lostTools, attemptedWrites });
      const unwritten = unwrittenError(result.outcome.finishReason, receipts.length > 0);
      if (unwritten) return { status: receipts.length ? "partial" : "failed", assistantText: result.outcome.assistantText, ...(reasoning ? { reasoning } : {}), ...(receipts.length ? { receipt } : {}), error: unwritten };
      if (receipts.length) {
        await rememberNative();
        return { status: "succeeded", assistantText: result.outcome.assistantText, ...(reasoning ? { reasoning } : {}), receipt };
      }
      // 没有回执时按真实动作分类：模型自己发过调用却没送达网关，是运行时丢调用，不是「未确认」。
      if (attemptedWrites > 0) return { status: "failed", assistantText: result.outcome.assistantText, ...(reasoning ? { reasoning } : {}), error: { code: "write-rejected", message: "本轮写入没有成功（被拒绝或未完成）；请核对失败原因后重试" } };
      if (lostTools.length > 0) return { status: "failed", assistantText: result.outcome.assistantText, ...(reasoning ? { reasoning } : {}), error: { code: "tool-call-lost", message: `模型生成的工具调用（${lostTools.join("、")}）没有送达执行端，本轮未提交写入；请重试` } };
      return { status: "failed", assistantText: result.outcome.assistantText, ...(reasoning ? { reasoning } : {}), error: { code: "no-write-attempted", message: "模型只读取了上下文，没有提交任何写入；请重试，或把需求拆成更小的步骤" } };
    } catch (error) {
      await gateway?.drain();
      const receipts = gateway?.receipts ?? [];
      // Only the host's target preparation errors carry public domain diagnostics.
      // SDK exceptions can contain credentials/endpoints and must never be echoed.
      const failureCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
      // 宿主桥断线/超时是通道问题：既不是目标无效，也不该复用凭据脱敏后的原始文案。
      const bridgeUnavailable = stage === "target" && (failureCode === "host-bridge-unavailable" || failureCode === "executor-unavailable");
      const domainCode = stage === "target" && failureCode
        && /^(invalid-data|malformed-request|not-ready|not-found|unsupported-version|spatial-rejected|write-forbidden|read-forbidden|operation-conflict|outside-scope|unknown-footprint|lease-conflict|version-conflict|stale-epoch|target-unavailable|capability-unsupported|group-target-missing|scene-empty|reservation-conflict|receipt-unavailable|receipt-not-found|unauthorized|unavailable|request-conflict|unverified-run|unverified-stop)$/.test(failureCode) ? failureCode : null;
      const message = bridgeUnavailable ? "执行通道暂不可用，请稍后重试" : domainCode && error instanceof Error
        ? error.message.split(credential.secret).join("[凭据已隐藏]")
          .replace(/https?:\/\/[^\s，。；]+/gi, "[服务地址已隐藏]")
          .replace(/(?:bearer\s+|(?:api[_-]?key|token|authorization)\s*[:=]\s*)[^\s，。；]+/gi, "[凭据已隐藏]").slice(0, 1200)
        : stage === "target" ? "目标准备失败，请重新打开目标并检查范围与权限"
        : stage === "connection" ? "执行连接暂不可用，请检查连接后重试"
        : "执行未完成，请核对回合记录与运行依赖";
      return { status: receipts.length ? "partial" : controller.signal.aborted ? "cancelled" : "failed", error: { code: controller.signal.aborted ? "cancelled" : bridgeUnavailable ? "transport-unavailable" : domainCode ?? (stage === "target" ? "target-unavailable" : stage === "connection" ? "transport-unavailable" : "execution-failed"), message: controller.signal.aborted ? "回合已停止，已提交结果保留" : message }, ...(receipts.length ? { receipt: { kind: "canvas-commands", commands: receipts } } : {}) };
    } finally {
      options.tools?.revoke(input.requestId, { subject: input.owner, authLevel: "authenticated" });
      await gateway?.close(); await relay?.close();
      input.signal.removeEventListener("abort", abort); options.shutdownSignal?.removeEventListener("abort", abort); active.delete(resourceKey);
    }
  };
  return {
    id: adapter.adapterId,
    capabilities: () => ({ discussion: true, textDelivery: ASSISTANT_CANDIDATE_CAPABILITIES, candidateGeneration: ASSISTANT_CANDIDATE_CAPABILITIES, targets: ["model3d", "world", "canvas-group"], tools: true, models: "remote" }),
    authorization: async ({ owner }) => {
      const records = (await options.service.list(owner)).filter((record) => record.adapterId === adapter.adapterId);
      for (const record of records) if (await options.service.credentialConfigured({ owner, connectionId: record.connectionId, purpose: "model-api-key" })) return "ready";
      return "disconnected";
    },
    // 目录与连接描述必须给同一份档位：只返回 { id, label } 会让选择器看不到 Variant。
    models: async ({ owner }) => {
      const records = (await options.service.list(owner)).filter((record) => record.adapterId === adapter.adapterId);
      const models = records.flatMap((record) => sdkModelViews(adapter.adapterId, record));
      const capabilityRevision = agentReasoningRevision(...records.map((record) => modelCatalogForRecord(record).revision));
      return { models, capabilityRevision };
    },
    run: async (input) => {
      const controller = input.candidate ? new AbortController() : null;
      const abort = () => controller?.abort();
      if (controller) { input.signal.addEventListener("abort", abort, { once: true }); if (input.signal.aborted) abort(); }
      const operation = runInner(controller ? { ...input, signal: controller.signal } : input);
      const candidateKey = JSON.stringify([input.owner, input.requestId]);
      if (controller) candidateRuns.set(candidateKey, { controller, done: operation });
      options.inFlight?.add(operation);
      try { const outcome = await operation; journal.set(`${input.owner}:${input.requestId}`, outcome); return outcome; }
      finally { options.inFlight?.delete(operation); if (controller) { input.signal.removeEventListener("abort", abort); candidateRuns.delete(candidateKey); } }
    },
    cancel: async ({ owner, requestId, candidateContext }) => {
      if (!candidateContext) return;
      const running = candidateRuns.get(JSON.stringify([owner, requestId]));
      if (!running) throw new Error("无法确认 SDK 候选执行已停止");
      running.controller.abort();
      await running.done;
    },
    query: async ({ owner, requestId }) => journal.get(`${owner}:${requestId}`) ?? null
  };
}
export { findSdkAgentAdapter, SDK_AGENT_PLUGIN_ID };
