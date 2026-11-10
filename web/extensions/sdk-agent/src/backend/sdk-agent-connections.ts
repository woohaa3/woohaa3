import { sdkSourceFor, sdkSourceProtocol } from "./service-source.js";
/** Fixed framework dispatch. The host ledger owns idempotency; frameworks own inference loops. */
import type {
  AgentConnectionCapabilities, AgentConnectionModel, AgentConnectionStatus, AgentConversationAdapter, AgentAdapterRunInput,
  AgentAdapterRunOutcome, AgentConnectionRuntime, AgentEngineId, ApplicationToolDelegationFacade,
  ApplicationCanvasAuthoringFacade, ApplicationUserDelegation
} from "@woohaa3/contracts";
import {
  createEndpointPolicy, createModelTransport, nativeContextFor, nativeContextKey, preflightInput,
  preparedPromptText, type ConnectionService, type ConnectionDescriptor
} from "@woohaa3/agent-connections";
import { SDK_AGENT_ADAPTERS, SDK_AGENT_PLUGIN_ID, findSdkAgentAdapter, sdkEngineForAdapter, type SdkAgentAdapterDescriptor } from "../shared.js";
import { createAgentSdkAdapter, type AgentSdkTransport } from "./adapters/agent-sdk-adapter.js";
import { createFixedEngineRuntime, type FixedEngineRuntime } from "./fixed-engine-runtime.js";
import { createMcpTurnGateway } from "./mcp-turn-gateway.js";
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

/** 仅声明固定引擎已接线且模型家族明确支持的设置。兼容服务未知时沿用默认。 */
export function sdkReasoningEfforts(adapterId: string, model: string): readonly import("@woohaa3/contracts").AgentReasoningEffort[] {
  const engine = sdkEngineForAdapter(adapterId)?.engine;
  if (engine === "codex-agent-sdk" && /^(gpt-[56]|o[134])/.test(model)) return ["low", "medium", "high"];
  if (engine === "claude-agent-sdk" && /^claude-(opus|sonnet)-(4-[6-9]|[5-9])/.test(model)) return ["low", "medium", "high"];
  if (engine === "gemini-agent-adk" && /^gemini-3/.test(model)) return ["low", "high"];
  return [];
}

export function capabilitiesFor(_adapter: SdkAgentAdapterDescriptor): AgentConnectionCapabilities {
  return { textDelivery: ASSISTANT_CANDIDATE_CAPABILITIES, discussion: true, imageInput: false, tools: true, structuredResult: false, cancel: true, resume: true, targets: ["model3d", "world", "canvas-group"] };
}

export function createSdkAgentDescriptors(options: Pick<SdkAgentRuntimeOptions, "allowedHosts" | "allowHttp">): Record<string, ConnectionDescriptor> {
  return Object.fromEntries(SDK_AGENT_ADAPTERS.map((adapter) => [adapter.adapterId, {
    describe: ({ record, credentialConfigured }) => {
      const binding = sdkEngineForAdapter(adapter.adapterId)!;
      const endpointAllowed = createEndpointPolicy({ allowedHosts: options.allowedHosts, allowHttp: options.allowHttp }).check(record.baseUrl ?? adapter.officialBaseUrl).ok &&
        (adapter.allowCustomBaseUrl || !record.baseUrl || record.baseUrl.replace(/\/$/, "") === adapter.officialBaseUrl);
      const unknown = { state: "unknown" as const, checkedAt: null };
      const runtime: AgentConnectionRuntime = {
        schemaVersion: 1, apiType: binding.apiType, engine: binding.engine, engineVersion: binding.version,
        dependency: endpointAllowed ? (record.runtimeProbe?.version === `${binding.engine}@${binding.version}:1` ? record.runtimeProbe.evidence : unknown) : { state: "unavailable", reason: "服务地址不符合当前部署策略，请检查 Base URL" },
        tasks: {
          discussion: record.lastStatus?.modelAccess ?? unknown,
          imageInput: { state: "unavailable", reason: "当前引擎尚未开放图片附件" },
          targetExecution: record.lastStatus?.tools ?? unknown
        }
      };
      const models: AgentConnectionModel[] = (record.models ?? []).map((id) => ({ id, label: id, reasoningEfforts: sdkReasoningEfforts(adapter.adapterId, id), source: "user-provided", accountAuthorized: false, ...(record.modelCapabilities?.[id] ? { capabilities: record.modelCapabilities[id] } : {}) }));
      // A saved Key on an allowed endpoint makes the HTTP transport attemptable. This is not a model
      // probe: modelAccess stays unknown, and an explicit failed/unavailable evidence is preserved.
      const transport = record.lastStatus?.transport;
      const transportEvidence = transport && (transport.state === "failed" || transport.state === "unavailable")
        ? transport
        : endpointAllowed && credentialConfigured ? { state: "ready" as const, checkedAt: transport?.checkedAt ?? null } : transport ?? unknown;
      const status: AgentConnectionStatus = { transport: transportEvidence, credential: record.lastStatus?.credential ?? unknown,
        modelAccess: record.lastStatus?.modelAccess ?? unknown, tools: record.lastStatus?.tools ?? unknown };
      const blockedReason = !endpointAllowed ? runtime.dependency.reason
        : !credentialConfigured ? "尚未保存 API Key"
        : runtime.dependency.state === "unavailable" || runtime.dependency.state === "failed" ? runtime.dependency.reason
        : undefined;
      return { runtime, status, capabilities: capabilitiesFor(adapter), models, required: ["credential", "transport"], endpointAllowed,
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
    if (input.intent.reasoningEffort && !sdkReasoningEfforts(adapter.adapterId, model).includes(input.intent.reasoningEffort)) return fail("capability-unsupported", "当前模型未开放此思考强度，请使用默认设置");
    // 通道只消费宿主准备好的角色回合；缺失即拒绝，不从 mode/用户文字推断业务职责。
    const prepared = input.prepared;
    if (!prepared) return fail("role-not-found", "本回合没有宿主准备的角色请求");
    const toolNames = input.intent.action === "discuss" ? [] : prepared.tools;
    if (input.intent.action !== "discuss" && record.modelCapabilities?.[model]?.tools === false) return fail("capability-unsupported", "当前模型明确不支持工具，仅可用于讨论；请选择支持目标工具的模型");
    const preflight = preflightInput({ capabilities: capabilitiesFor(adapter), wantTools: toolNames.length > 0, imageCount: input.intent.references?.filter((ref) => ref.kind === "asset").length ?? 0, wantStructuredResult: false });
    if (!preflight.ok) return fail(preflight.code, preflight.message);
    const source = options.serviceConnections ? await sdkSourceFor(options.serviceConnections, input.owner, record.connectionId, options.service) : null;
    if (options.serviceConnections && !source) return fail("connection-unavailable", "模型提供商尚未迁移，请重试");
    let credential: { secret: string } | null;
    try {
      credential = source && options.serviceConnections ? await options.serviceConnections.resolve(input.owner, {
        ...source, bindingId: source.bindings.find(binding => binding.extensionId === "sdk-agent" && (binding.consumerId === record.connectionId || record.serviceConnectionId && binding.consumerId === `shared:${sdkSourceProtocol(record.adapterId)}`))?.bindingId ?? "", purpose: input.intent.action === "discuss" ? "discussion" : "target-execution",
        protocol: sdkSourceProtocol(record.adapterId), modelId: model, endpoint: baseUrl,
      }) : await options.service.readCredential<{ secret: string }>({ owner: input.owner, connectionId: record.connectionId, purpose: "model-api-key" });
    } catch { return fail("version-conflict", "模型提供商或用途已失效，请重新读取"); }
    if (!credential?.secret) return fail("credential-missing", "该连接尚未保存 API Key");
    let transport: AgentSdkTransport;
    try {
      transport = options.transports?.[engine.engine] ?? await runtime!.resolve(engine.engine);
    } catch {
      await options.service.setRuntimeProbe?.(input.owner, record.connectionId, `${engine.engine}@${engine.version}:1`, { state: "unavailable", checkedAt: new Date().toISOString(), reason: "缺少配套运行时，请重新安装对应平台扩展" });
      return fail("runtime-missing", `缺少 ${engine.engine} ${engine.version} 配套运行时`);
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
      const native = input.candidate ? null : await options.service.resolveNativeBinding({ owner: input.owner, connectionId: record.connectionId, context });
      const sdk = createAgentSdkAdapter({ kind: engine.engine, apiKey: relay.token, modelBaseUrl: relay.baseUrl, resourceKey,
        configDir: options.agentSdkDirs?.configDir ?? "", workspaceDir: options.agentSdkDirs?.workspaceDir ?? "", transport,
        probeRuntime: async () => ({ ok: true }) });
      // Legal host history is replayable when an engine cannot resume or the process restarted.
      const history = (native && input.intent.action !== "discuss" ? [] : input.history).map((message) => `${message.role}: ${message.content}`).join("\n");
      const prompt = (history ? `会话历史：\n${history}\n\n` : "") + preparedPromptText(prepared);
      const result = await sdk.run({ model, prompt, ...(input.intent.reasoningEffort ? { reasoningEffort: input.intent.reasoningEffort } : {}), signal: controller.signal, tools: gateway?.tools ?? [],
        ...(input.candidate
          ? { images: input.candidate.images, outputSchema: prepared.output.kind === "candidate" ? prepared.output.schema : input.candidate.outputSchema }
          : input.images?.length ? { images: input.images }
          : {}),
        ...(gateway ? { toolToken: gateway.token, mcpEndpoint: { name: "woohaa", url: gateway.url } } : {}),
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
      const receipt = { kind: "canvas-commands", commands: receipts };
      if (!result.ok) return { status: receipts.length ? "partial" : result.code === "cancelled" ? "cancelled" : "failed", error: { code: result.code, message: result.message }, ...(receipts.length ? { receipt } : {}) };
      if (input.candidate && !await valid()) return controller.signal.aborted ? { status: "cancelled" } : fail("version-conflict", "助手连接已变更，结果未采用");
      if (result.nativeId && !input.candidate && await valid()) await options.service.setNativeBinding({ owner: input.owner, connectionId: record.connectionId, context, native: { nativeId: result.nativeId, credentialEpoch: record.credentialEpoch, conversationId: input.conversationId, updatedAt: new Date().toISOString() } });
      await options.service.setStatus({ owner: input.owner, connectionId: record.connectionId, patch: { transport: { state: "ready", checkedAt: new Date().toISOString() }, modelAccess: { state: "ready", checkedAt: new Date().toISOString() }, ...(receipts.length ? { tools: { state: "ready" as const, checkedAt: new Date().toISOString() } } : {}) } });
      if (input.intent.action === "discuss") return { status: "succeeded", assistantText: result.outcome.assistantText };
      return receipts.length ? { status: "succeeded", assistantText: result.outcome.assistantText, receipt } :
        { status: "failed", assistantText: result.outcome.assistantText, error: { code: "write-unconfirmed", message: "回复完成，作品更新未确认；请核对原请求" } };
    } catch (error) {
      await gateway?.drain();
      const receipts = gateway?.receipts ?? [];
      // Only the host's target preparation errors carry public domain diagnostics.
      // SDK exceptions can contain credentials/endpoints and must never be echoed.
      const domainCode = stage === "target" && error && typeof error === "object" && "code" in error && typeof error.code === "string"
        && /^(invalid-data|malformed-request|not-ready|not-found|unsupported-version|spatial-rejected|write-forbidden|operation-conflict|outside-scope|unknown-footprint|lease-conflict|version-conflict|stale-epoch|target-unavailable|capability-unsupported|group-target-missing|unauthorized|unavailable|request-conflict|unverified-run|unverified-stop)$/.test(error.code) ? error.code : null;
      const message = domainCode && error instanceof Error
        ? error.message.split(credential.secret).join("[凭据已隐藏]")
          .replace(/https?:\/\/[^\s，。；]+/gi, "[服务地址已隐藏]")
          .replace(/(?:bearer\s+|(?:api[_-]?key|token|authorization)\s*[:=]\s*)[^\s，。；]+/gi, "[凭据已隐藏]").slice(0, 1200)
        : stage === "target" ? "目标准备失败，请重新打开目标并检查范围与权限"
        : stage === "connection" ? "执行连接暂不可用，请检查连接后重试"
        : "执行未完成，请核对回合记录与运行依赖";
      return { status: receipts.length ? "partial" : controller.signal.aborted ? "cancelled" : "failed", error: { code: controller.signal.aborted ? "cancelled" : domainCode ?? (stage === "target" ? "target-unavailable" : stage === "connection" ? "transport-unavailable" : "execution-failed"), message: controller.signal.aborted ? "回合已停止，已提交结果保留" : message }, ...(receipts.length ? { receipt: { kind: "canvas-commands", commands: receipts } } : {}) };
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
    models: async ({ owner }) => ({ models: (await options.service.list(owner)).filter((record) => record.adapterId === adapter.adapterId).flatMap((record) => (record.models ?? []).map((id) => ({ id, label: id }))) }),
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
