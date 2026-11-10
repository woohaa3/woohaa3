/**
 * 宿主的运行时执行器适配（change: 2026-11-07-add-pluggable-agent-roles）。
 *
 * 本机回合只经 daemon 执行；缺少配置或连接失败直接失败，不调用宿主进程内执行。
 */
import type {
  AgentAdapterRunInput,
  AgentAdapterRunOutcome,
  AgentConnectionBinding,
  AgentConversationAdapter,
  AgentConversationAdapterEvent
} from "@woohaa3/contracts";
import type { AgentConnectionRegistry } from "./agent-connection-registry.js";
import { createHash } from "node:crypto";
import { createExecutorClient, followTurn } from "woohaa3-executor/client";
import type { RuntimeEvent, TurnView } from "woohaa3-executor/protocol";

export type HostRuntimeOptions = {
  socketPath: string;
  token: string;
  workspaceKey: string;
  executor: string;
  ensure?: () => Promise<void>;
  hostCalls?: {
    registerCall(
      handler: (method: string, params: unknown) => Promise<unknown>,
      claims?: { turnId: string; requestId: string; owner: string; methods: readonly string[]; exp: number }
    ): { leaseId: string; release(): void };
  };
  bridge: { socketPath: string; token: string; workspaceKey: string };
  mcpEndpoint?: string;
};

type RuntimePayload = {
  owner: string;
  canvasId: string;
  conversationId: string;
  intent: AgentAdapterRunInput["intent"];
  connection: AgentConnectionBinding;
  record: Record<string, unknown>;
  history: AgentAdapterRunInput["history"];
  images?: Array<{ bytes: string; contentType: string }>;
  mcpEndpoint?: { name: string; url: string };
  bridge: HostRuntimeOptions["bridge"];
  candidate?: { images: Array<{ bytes: string; contentType: string }>; outputSchema: Record<string, unknown> };
};

/** 每次候选尝试有独立 requestId；查询、取消及重启恢复使用同一个确定性执行身份。 */
export function runtimeTurnId(owner: string, requestId: string): string {
  return createHash("sha256").update(JSON.stringify([owner, requestId])).digest("hex");
}

/** 产物事实来自 daemon journal，不能依赖宿主与执行器共享内存。 */
export async function readRuntimeGeneratedImages(
  options: Pick<HostRuntimeOptions, "socketPath" | "token" | "workspaceKey">,
  owner: string,
  requestId: string
): Promise<{ codexHome: string; paths: string[] }> {
  if (!options.socketPath || !options.token || !options.workspaceKey) throw new Error("宿主未配置独立执行器");
  const client = createExecutorClient(options);
  const page = await client.turnEvents(runtimeTurnId(owner, requestId));
  const images = page.events.filter((event) => event.type === "generated-image").map((event) => event.payload as { savedPath: string; codexHome: string });
  if (images.length === 0) throw new Error("本回合尚未登记生图产物");
  return { codexHome: images[0]!.codexHome, paths: images.map((image) => image.savedPath) };
}

function outcomeFromView(view: TurnView | null): AgentAdapterRunOutcome | null {
  if (!view) return null;
  const result = view.result as { outcome?: AgentAdapterRunOutcome } | undefined;
  if (view.status === "cancelled" || view.status === "failed") return { ...result?.outcome, status: view.status, error: view.error };
  if (result?.outcome) return result.outcome;
  if (view.status === "succeeded") return { status: "succeeded" };
  return null;
}

function mapRuntimeEvent(event: RuntimeEvent): AgentConversationAdapterEvent | null {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") return null;
  if (event.type === "message" && typeof payload.content === "string") {
    return {
      type: "message",
      role: payload.role === "system" ? "system" : "assistant",
      content: payload.content,
      ...(payload.delivery === "append" || payload.delivery === "replace" ? { delivery: payload.delivery } : {}),
      ...(typeof payload.streamId === "string" ? { streamId: payload.streamId } : {})
    };
  }
  if (event.type === "stage") {
    return {
      type: "stage",
      stage: typeof payload.stage === "string" ? payload.stage : "running",
      ...(typeof payload.detail === "string" ? { detail: payload.detail } : {}),
      ...(typeof payload.summary === "string" ? { summary: payload.summary } : {})
    };
  }
  if (event.type === "tool-started") {
    return {
      type: "tool-started",
      tool: typeof payload.tool === "string" ? payload.tool : "tool",
      ...(typeof payload.callId === "string" ? { callId: payload.callId } : {}),
      ...(typeof payload.summary === "string" ? { summary: payload.summary } : {})
    };
  }
  if (event.type === "tool-completed") {
    return {
      type: "tool-completed",
      tool: typeof payload.tool === "string" ? payload.tool : "tool",
      ...(typeof payload.callId === "string" ? { callId: payload.callId } : {}),
      ok: payload.ok === true,
      ...(typeof payload.summary === "string" ? { summary: payload.summary } : {})
    };
  }
  return null;
}

/** 接管时按 cursor 幂等投递；普通回合仍走 `emit`。 */
function deliverRuntimeEvent(input: AgentAdapterRunInput, event: RuntimeEvent): void {
  const mapped = mapRuntimeEvent(event);
  if (!mapped) return;
  if (input.emitExecutor) input.emitExecutor(event.cursor, mapped);
  else input.emit(mapped);
}

/**
 * 把声明 runtimeExecutor 的 adapter 包装成 daemon 客户端。
 */
export function createRuntimeConversationAdapter(
  adapter: AgentConversationAdapter,
  options: HostRuntimeOptions | undefined,
  connections?: Pick<AgentConnectionRegistry, "getConnection">
): AgentConversationAdapter {
  const client = options ? createExecutorClient({
    socketPath: options.socketPath,
    token: options.token,
    workspaceKey: options.workspaceKey
  }) : null;
  /**
   * 宿主重启接管（任务 3.2）：只查询既有 journal 并继续跟随，不重新提交、不重新推理。
   *
   * 执行器已丢失该回合时返回 `null`，由宿主走「按原身份核对领域回执」的不可证明路径。
   */
  const resume = async (input: AgentAdapterRunInput): Promise<AgentAdapterRunOutcome | null> => {
    if (!client || !options) return null;
    // 重启窗口内连接/凭据被切换或撤销：按事实拒绝，不沿用旧授权继续执行。
    if (input.connection && connections) {
      const current = await connections.getConnection({ owner: input.owner, connectionId: input.connection.connectionId }).catch(() => null);
      if (!current || current.adapterId !== input.connection.adapterId
        || current.configRevision !== input.connection.configRevision
        || current.credentialEpoch !== input.connection.credentialEpoch) {
        return { status: "failed", error: { code: "connection-unavailable", message: "连接在宿主重启期间已变更或撤销" } };
      }
    }
    const executionId = runtimeTurnId(input.owner, input.requestId);
    const existing = await client.queryTurn(executionId).catch(() => null);
    if (!existing) return null;
    const since = typeof input.resumeCursor === "number"
      ? input.resumeCursor
      : (await client.turnEvents(executionId, 0)).cursor;
    await followTurn(client, executionId, {
      intervalMs: 150,
      since,
      signal: input.signal,
      onEvent: (event) => deliverRuntimeEvent(input, event)
    });
    await client.call("turn.drain", { turnId: executionId });
    return outcomeFromView(await client.queryTurn(executionId));
  };

  return {
    ...adapter,
    capabilities: () => adapter.capabilities(),
    authorization: (input) => adapter.authorization(input),
    models: (input) => adapter.models(input),
    async run(input) {
      if (input.resumeCursor !== undefined) {
        return (await resume(input)) ?? { status: "failed", error: { code: "journal-missing", message: "执行器已丢失该回合" } };
      }
      if (!input.prepared) return { status: "failed", error: { code: "role-not-found", message: "缺少宿主准备的角色请求" } };
      if (!client || !options) return { status: "failed", error: { code: "runtime-unavailable", message: "宿主未配置独立执行器" } };
      if (!input.connection) return { status: "failed", error: { code: "connection-unavailable", message: "回合未冻结助手连接" } };
      if (input.signal.aborted) return { status: "cancelled" };
      const view = await connections?.getConnection({ owner: input.owner, connectionId: input.connection.connectionId });
      if (!view) return { status: "failed", error: { code: "connection-unavailable", message: "连接不存在或无权访问" } };
      const record = {
        owner: input.owner,
        connectionId: input.connection.connectionId,
        adapterId: input.connection.adapterId,
        name: view.name,
        runCategory: view.runCategory,
        authMode: view.authMode,
        configRevision: view.configRevision,
        credentialEpoch: view.credentialEpoch,
        models: view.models.map((model) => model.id),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      const payload: RuntimePayload = {
        owner: input.owner,
        canvasId: input.canvasId,
        conversationId: input.conversationId,
        intent: input.intent,
        connection: input.connection,
        record,
        history: input.history,
        ...(input.images ? { images: input.images.map((image) => ({ bytes: Buffer.from(image.bytes).toString("base64"), contentType: image.contentType })) } : {}),
        bridge: options.bridge,
        ...(options.mcpEndpoint ? { mcpEndpoint: { name: "woohaa", url: options.mcpEndpoint } } : {}),
        ...(input.candidate
          ? {
              candidate: {
                images: input.candidate.images.map((image) => ({ bytes: Buffer.from(image.bytes).toString("base64"), contentType: image.contentType })),
                outputSchema: input.candidate.outputSchema
              }
            }
          : {})
      };
      const executionId = runtimeTurnId(input.owner, input.requestId);
      let cancellation: Promise<unknown> | undefined;
      const abort = () => { cancellation = client.cancelTurn(executionId); void cancellation.catch(() => undefined); };
      input.signal.addEventListener("abort", abort, { once: true });
      try {
        await options.ensure?.();
        const turn = await client.runTurn({
          turnId: executionId,
          requestId: input.requestId,
          kind: "agent",
          executor: options.executor,
          prepared: input.prepared,
          host: options.bridge,
          payload
        });
        // 取消可能先于 turn.run 受理到达 daemon；受理后再确认一次。
        if (input.signal.aborted) abort();
        await followTurn(client, turn.turnId, {
          intervalMs: 150,
          signal: input.signal,
          onEvent: (event) => {
            deliverRuntimeEvent(input, event);
          }
        });
        await cancellation;
        await client.call("turn.drain", { turnId: executionId });
        const final = await client.queryTurn(executionId);
        return outcomeFromView(final) ?? { status: "failed", error: { code: "runtime-failed", message: "执行器未返回终态" } };
      } catch (error) {
        return { status: "failed", error: { code: "runtime-error", message: error instanceof Error ? error.message : String(error) } };
      } finally {
        input.signal.removeEventListener("abort", abort);
      }
    },
    async cancel(input) {
      if (!client) throw new Error("宿主未配置独立执行器");
      await client.cancelTurn(runtimeTurnId(input.owner, input.requestId));
      await client.call("turn.drain", { turnId: runtimeTurnId(input.owner, input.requestId) });
    },
    async query(input) {
      if (!client) throw new Error("宿主未配置独立执行器");
      const view = await client.queryTurn(runtimeTurnId(input.owner, input.requestId));
      if (!view || view.status === "queued" || view.status === "running") return null;
      return outcomeFromView(view);
    },
    resume
  };
}
