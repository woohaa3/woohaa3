import type { AgentAdapterRunInput, AgentEngineId } from "@woohaa3/contracts";
import type { Executor, ExecutorHostPort } from "woohaa3-executor/protocol";
import type { AgentSdkTransport } from "./adapters/agent-sdk-adapter.js";
import { createSdkAgentConversationAdapter, type SdkAgentRuntimeOptions } from "./sdk-agent-connections.js";
import { findSdkAgentAdapter } from "../shared.js";

export function createExecutor(options: { transports?: Partial<Record<AgentEngineId, AgentSdkTransport>> } = {}): Executor {
  return { id: "sdk-agent", kind: "agent", async run(turn, context) {
    if (!turn.prepared || !context.host) throw new Error("SDK executor requires a prepared turn and host lease");
    const payload = turn.payload as { input: AgentAdapterRunInput; deployment: Pick<SdkAgentRuntimeOptions, "allowHttp" | "allowedHosts" | "agentSdkDirs" | "mcpServerUrl"> & { hasTools: boolean; hasAuthoring: boolean } };
    const host: ExecutorHostPort = context.host;
    const call = <T>(method: string, ...args: unknown[]) => host.call<T>(method, args);
    const connection = payload.input.connection;
    const adapter = connection && findSdkAgentAdapter(connection.adapterId);
    if (!adapter) throw new Error("Unknown SDK adapter");
    const service = {
      get: () => call("connection.get"), readCredential: <T>() => call<T | null>("connection.credential"),
      setRuntimeProbe: (_owner: string, _id: string, version: string, evidence: unknown) => call("connection.probe", version, evidence),
      resolveNativeBinding: () => call("connection.native.get"), setNativeBinding: (value: { native: unknown }) => call("connection.native.set", value.native),
      setStatus: (value: { patch: unknown }) => call("connection.status", value.patch),
      list: () => Promise.reject(new Error("Executor cannot enumerate host connections")),
      credentialConfigured: () => Promise.reject(new Error("Executor cannot enumerate host credentials")),
    } satisfies SdkAgentRuntimeOptions["service"];
    const pending = new Set<Promise<unknown>>();
    const revoke = () => { const operation = call("tools.revoke"); pending.add(operation); void operation.finally(() => pending.delete(operation)).catch(() => undefined); };
    const decodeImages = (images: AgentAdapterRunInput["images"]) => images?.map(image => ({ ...image, bytes: Buffer.from(image.bytes as unknown as string, "base64") }));
    const input: AgentAdapterRunInput = { ...payload.input, prepared: turn.prepared, signal: context.signal, emit: event => context.emit("agent-event", event),
      images: decodeImages(payload.input.images), ...(payload.input.candidate ? { candidate: { ...payload.input.candidate, images: decodeImages(payload.input.candidate.images)! } } : {}) };
    const instance = createSdkAgentConversationAdapter(adapter, { ...payload.deployment, service, ...options, workspace: context.workspace,
      ...(payload.deployment.hasAuthoring ? { authoring: { readNode: () => call("authoring.read") } } : {}),
      ...(payload.deployment.hasTools ? { tools: { issue: (value: unknown) => call<Awaited<ReturnType<NonNullable<SdkAgentRuntimeOptions["tools"]>["issue"]>>>("tools.issue", value), revoke } } : {}) });
    try {
      const outcome = await instance.run(input);
      return outcome.status === "succeeded" || outcome.status === "partial" ? { status: "succeeded", result: { outcome } }
        : { status: outcome.status === "cancelled" ? "cancelled" : "failed", error: outcome.error ?? { code: "sdk-failed", message: "SDK execution failed" }, result: { outcome } };
    } finally { await Promise.allSettled([...pending]); }
  } };
}
