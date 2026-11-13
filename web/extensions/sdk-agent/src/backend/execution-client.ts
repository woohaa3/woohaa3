import type { AgentAdapterRunInput, AgentAdapterRunOutcome, AgentConversationAdapter } from "@woohaa3/contracts";
import { nativeContextFor } from "@woohaa3/agent-connections";
import type { SdkAgentAdapterDescriptor } from "../shared.js";
import { sdkEngineForAdapter } from "../shared.js";
import { sdkSourceFor, sdkSourceProtocol } from "./service-source.js";
import { createSdkAgentConversationAdapter as createMetadataAdapter, type SdkAgentRuntimeOptions } from "./sdk-agent-connections.js";

/** 本通道实现（switch）实际支持的 host-call 方法；写入回合授权供接管校验。 */
const SDK_HOST_METHODS = [
  "connection.get",
  "connection.credential",
  "connection.probe",
  "connection.native.get",
  "connection.native.set",
  "connection.status",
  "authoring.read",
  "tools.issue",
  "tools.revoke"
] as const;

/** Host-side metadata and authority. Inference always runs in the separately loaded executor. */
export function createSdkAgentConversationAdapter(adapter: SdkAgentAdapterDescriptor, options: SdkAgentRuntimeOptions): AgentConversationAdapter {
  const metadata = createMetadataAdapter(adapter, options);
  const unwrap = (result: import("@woohaa3/contracts").ExtensionExecutorOutcome): AgentAdapterRunOutcome => {
    const outcome = (result.result as { outcome?: AgentAdapterRunOutcome } | undefined)?.outcome;
    if (result.status !== "succeeded") return { ...outcome, status: result.status, error: result.error };
    return outcome ?? { status: "failed", error: { code: "runtime-error", message: "执行器缺少结果" } };
  };
  return { ...metadata,
    async cancel(input) {
      if (!options.executor) throw new Error("宿主未配置 SDK 执行器");
      await options.executor.cancel({ ...input, executor: "sdk-agent" });
    },
    async query(input) {
      if (!options.executor) throw new Error("宿主未配置 SDK 执行器");
      const outcome = await options.executor.query({ ...input, executor: "sdk-agent" });
      return outcome ? unwrap(outcome) : null;
    },
    resume(input) {
      return this.run(input);
    },
    async run(input) {
      if (!options.executor) return { status: "failed", error: { code: "runtime-unavailable", message: "宿主未配置 SDK 执行器" } };
      if (!input.prepared || !input.connection) return { status: "failed", error: { code: "role-not-found", message: "缺少准备好的角色回合或连接" } };
      const connection = input.connection;
      const record = await options.service.get(input.owner, connection.connectionId);
      if (!record || record.adapterId !== adapter.adapterId || record.configRevision !== connection.configRevision || record.credentialEpoch !== connection.credentialEpoch) return { status: "failed", error: { code: "version-conflict", message: "连接已变更" } };
      const model = input.intent.model;
      if (!model) return { status: "failed", error: { code: "malformed-request", message: "请选择模型" } };
      const engine = sdkEngineForAdapter(adapter.adapterId)!;
      const nativeContext = nativeContextFor(input, `${engine.engine}@${engine.version}:1`);
      const hostCall = async (method: string, raw: unknown): Promise<unknown> => {
        const args = Array.isArray(raw) ? raw : [];
        const current = await options.service.get(input.owner, connection.connectionId);
        if (!current || current.configRevision !== connection.configRevision || current.credentialEpoch !== connection.credentialEpoch || options.admission?.() === false) throw new Error("SDK connection authorization changed");
        const identity = { owner: input.owner, connectionId: connection.connectionId };
        switch (method) {
          case "connection.get": return current;
          case "connection.credential": {
            if (!options.serviceConnections) return options.service.readCredential({ ...identity, purpose: "model-api-key" });
            const source = await sdkSourceFor(options.serviceConnections, input.owner, connection.connectionId, options.service);
            if (!source) throw new Error("SDK source unavailable");
            return options.serviceConnections.resolve(input.owner, { ...source,
              bindingId: source.bindings.find(binding => binding.extensionId === "sdk-agent" && (binding.consumerId === connection.connectionId || record.serviceConnectionId && binding.consumerId === `shared:${sdkSourceProtocol(record.adapterId)}`))?.bindingId ?? "",
              purpose: "text", protocol: sdkSourceProtocol(record.adapterId), modelId: model, endpoint: record.baseUrl ?? adapter.officialBaseUrl });
          }
          case "connection.probe": return options.service.setRuntimeProbe?.(input.owner, connection.connectionId, String(args[0]), args[1] as never);
          case "connection.native.get": return options.service.resolveNativeBinding({ ...identity, context: nativeContext });
          case "connection.native.set": return options.service.setNativeBinding({ ...identity, context: nativeContext, native: { ...(args[0] as object), credentialEpoch: connection.credentialEpoch, conversationId: input.conversationId } } as never);
          case "connection.status": return options.service.setStatus({ ...identity, patch: args[0] as never });
          case "authoring.read":
            if (!options.authoring || !input.intent.nodeId) throw new Error("Authoring unavailable");
            return options.authoring.readNode({ delegation: { subject: input.owner, authLevel: "authenticated" }, canvasId: input.canvasId, nodeId: input.intent.nodeId });
          case "tools.issue": {
            if (!options.tools || input.intent.action === "discuss" || !input.intent.nodeId) throw new Error("Tools unavailable");
            return options.tools.issue({ delegation: { subject: input.owner, authLevel: "authenticated" }, workId: input.requestId,
              canvasId: input.canvasId, nodeId: input.intent.nodeId, mode: input.intent.mode, tools: [...input.prepared!.tools],
              cameraId: input.intent.cameraId, worldScope: input.intent.worldScope,
              ...(input.intent.worldScope?.kind === "scene-area" ? { allowSceneAreaExpansion: input.intent.allowSceneAreaExpansion === true } : {}),
              ...(input.intent.mode === "canvas-group" && input.intent.expectedContentHash?.startsWith("group-epoch:") ? { expectedScopeEpoch: Number(input.intent.expectedContentHash.slice("group-epoch:".length)) } : {}) });
          }
          case "tools.revoke": options.tools?.revoke(input.requestId, { subject: input.owner, authLevel: "authenticated" }); return null;
          default: throw new Error(`Unknown SDK host method: ${method}`);
        }
      };
      const { emit: _emit, signal: _signal, ...serializable } = input;
      const images = (values: AgentAdapterRunInput["images"]) => values?.map(image => ({ ...image, bytes: Buffer.from(image.bytes).toString("base64") }));
      try {
        const result = await options.executor.run({ executor: "sdk-agent", owner: input.owner, requestId: input.requestId, prepared: input.prepared, signal: input.signal,
          ...(input.resumeCursor !== undefined ? { since: input.resumeCursor, resume: true } : {}),
          hostMethods: SDK_HOST_METHODS,
          payload: { input: { ...serializable, images: images(input.images), ...(input.candidate ? { candidate: { ...input.candidate, images: images(input.candidate.images) } } : {}) },
            deployment: { allowedHosts: options.allowedHosts, allowHttp: options.allowHttp, agentSdkDirs: options.agentSdkDirs, mcpServerUrl: options.mcpServerUrl, hasTools: !!options.tools, hasAuthoring: !!options.authoring } },
          hostCall,
          onEvent: (event, cursor) => {
            if (event.type !== "agent-event") return;
            const mapped = event.payload as Parameters<typeof input.emit>[0];
            if (cursor !== undefined && input.emitExecutor) input.emitExecutor(cursor, mapped);
            else input.emit(mapped);
          } });
        return unwrap(result);
      } catch (error) { return { status: "failed", error: { code: "runtime-error", message: error instanceof Error ? error.message : String(error) } }; }
      finally { options.tools?.revoke(input.requestId, { subject: input.owner, authLevel: "authenticated" }); }
    }
  };
}
