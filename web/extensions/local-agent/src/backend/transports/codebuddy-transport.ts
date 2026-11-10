/** CodeBuddy 2.x ACP: GET opens a connection, JSON-RPC POST replies may also stream. */
import { assertCodeBuddyWriteScope } from "../protocol/codebuddy-acp.js";
import type { LocalAgentTransport, LocalAgentTransportInput, LocalAgentTransportResult } from "./transport.js";
import { canvasToolName, consumeSse, loopbackHttp, toolResultDetail, toolResultFailed } from "./loopback-http.js";

export type CodeBuddyTransportOptions = {
  fetchImpl?: typeof globalThis.fetch;
  writeRotationVerified?: boolean;
  logger?: (event: Record<string, unknown>) => void;
};

/** DeferExecuteTool must be authorized against its target, never as a blanket proxy. */
export function codeBuddyTool(call: Record<string, any> | undefined, allowed: readonly string[]): string {
  const meta = call?._meta?.["codebuddy.ai"];
  const name = meta?.toolName ?? meta?.toolMetaData?.toolName ?? call?.title ?? "";
  const effectiveName = meta?.effectiveToolName ?? meta?.toolMetaData?.effectiveToolName ?? call?.effectiveToolName;
  if (name === "DeferExecuteTool" && typeof effectiveName === "string") return canvasToolName(effectiveName, allowed);
  if (name !== "DeferExecuteTool") return canvasToolName(name, allowed);
  let args = call?.rawInput;
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { return name; } }
  return typeof args?.toolName === "string" ? canvasToolName(args.toolName, allowed) : name;
}

export function createCodeBuddyTransport(options: CodeBuddyTransportOptions = {}): LocalAgentTransport {
  return {
    id: "codebuddy-server",
    probe: async () => ({ ok: true }),
    async run(input: LocalAgentTransportInput): Promise<LocalAgentTransportResult> {
      if (!input.loopbackUrl) return { ok: false, code: "runtime-missing", message: "CodeBuddy 专用进程未启动" };
      const scope = assertCodeBuddyWriteScope({ requestedTools: input.allowedTools, rotationVerified: options.writeRotationVerified });
      if (!scope.ok) return scope;
      if (input.allowedTools.length && (!input.mcpEndpoint || !input.toolToken)) return { ok: false, code: "tools-unavailable", message: "本轮缺少远程 MCP 地址或授权" };
      const controller = new AbortController();
      const signal = AbortSignal.any([input.signal, controller.signal]);
      const http = loopbackHttp(input.loopbackUrl, { ...input.httpHeaders, "x-codebuddy-request": "true" }, signal, options.fetchImpl ?? fetch);
      const pending = new Map<number, { resolve: (value: Record<string, any>) => void; reject: (error: Error) => void }>();
      let nextId = 0;
      let connectionId: string | null = null;
      let sessionId: string | undefined;
      let assistantText = "";
      let prompting = false;
      let candidateToolViolation = false;
      const toolNames = new Map<string, string>();
      const headers = () => ({ "Acp-Connection-Id": connectionId!, accept: "application/json, text/event-stream", "content-type": "application/json" });
      const failPending = (error: Error) => { for (const item of pending.values()) item.reject(error); pending.clear(); };
      const onAbort = () => failPending(signal.reason instanceof Error ? signal.reason : new Error("CodeBuddy 回合已中断或超时"));
      signal.addEventListener("abort", onAbort, { once: true });
      const dispatch = (message: Record<string, any>) => {
        if (typeof message.id === "number" && !message.method) {
          const entry = pending.get(message.id);
          if (!entry) return;
          pending.delete(message.id);
          if (message.error) entry.reject(new Error(message.error.message ?? "CodeBuddy ACP 请求失败"));
          else entry.resolve(message.result ?? {});
        } else if (prompting && message.method === "session/update" && message.params?.sessionId === sessionId) {
          const update = message.params.update;
          if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
            assistantText += update.content.text;
            input.onEvent({ type: "message", role: "assistant", content: update.content.text, delivery: "append", streamId: `codebuddy:${sessionId}` });
          } else if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") {
            if (input.outputSchema) candidateToolViolation = true;
            const name = toolNames.get(update.toolCallId) ?? codeBuddyTool(update, input.allowedTools);
            if (!input.allowedTools.includes(name)) return;
            if (update.sessionUpdate === "tool_call") {
              toolNames.set(update.toolCallId, name);
              input.onEvent({ type: "tool-started", tool: name, callId: update.toolCallId });
            }
            if (update.status === "completed" || update.status === "failed") {
              const failed = update.status !== "completed" || toolResultFailed(update.rawOutput) || toolResultFailed(update.content);
              // 失败时保留真实原因（结构化 code/message、工具输出或协议错误），不退回通用占位。
              const detail = failed
                ? toolResultDetail(update.rawOutput) ?? toolResultDetail(update.content) ?? (typeof update.error?.message === "string" ? update.error.message : undefined)
                : undefined;
              input.onEvent({ type: "tool-completed", tool: toolNames.get(update.toolCallId) ?? name, callId: update.toolCallId, ok: !failed, ...(detail ? { summary: detail } : {}) });
            }
          }
        } else if (message.method && message.id !== undefined) {
          const call = message.params?.toolCall;
          const name = codeBuddyTool(call, input.allowedTools);
          const allowed = message.method === "session/request_permission" && message.params?.sessionId === sessionId && (input.allowedTools.includes(name) || (name === "ToolSearch" && input.allowedTools.length > 0));
          const option = allowed ? message.params.options?.find((item: { kind: string }) => item.kind === "allow_once") : undefined;
          const response = message.method === "session/request_permission"
            ? { result: { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } } }
            : { error: { code: -32601, message: "WooHaa only exposes canvas MCP tools" } };
          void http.request("/api/v1/acp", { method: "POST", headers: headers(), body: JSON.stringify({ jsonrpc: "2.0", id: message.id, ...response }) })
            .then(async result => { await result.body?.cancel(); }, failPending);
        }
      };
      const rpc = async (method: string, params: unknown): Promise<Record<string, any>> => {
        signal.throwIfAborted();
        const id = ++nextId;
        const response = new Promise<Record<string, any>>((resolve, reject) => pending.set(id, { resolve, reject }));
        void response.catch(() => undefined);
        const timeout = method === "session/prompt" ? undefined : setTimeout(() => controller.abort(new Error(`CodeBuddy ${method} 超时`)), 30_000);
        try {
          const result = await http.request("/api/v1/acp", { method: "POST", headers: headers(), body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal });
          if ((result.headers.get("content-type") ?? "").includes("text/event-stream")) await consumeSse(result, dispatch);
          else if ((result.headers.get("content-type") ?? "").includes("application/json")) dispatch(await result.json());
          else if (result.status !== 202 && result.status !== 204) throw new Error("CodeBuddy ACP 响应格式不支持");
          return await response;
        } finally { clearTimeout(timeout); pending.delete(id); }
      };
      let eventStream: Promise<void> | undefined;
      try {
        const stream = await http.ready("/api/v1/acp", { headers: { accept: "text/event-stream" } });
        connectionId = stream.headers.get("Acp-Connection-Id");
        if (!connectionId) { await stream.body?.cancel(); throw new Error("CodeBuddy 未返回 ACP 连接 id"); }
        eventStream = consumeSse(stream, dispatch).then(() => { if (!signal.aborted) controller.abort(new Error("CodeBuddy ACP 事件流提前结束")); }, error => { if (!signal.aborted) controller.abort(error); });
        const initialized = await rpc("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "woohaa3", version: "0.1.0" } });
        if (initialized.protocolVersion !== 1) throw new Error("CodeBuddy ACP 协议版本不支持");
        if (input.images?.length && initialized.agentCapabilities?.promptCapabilities?.image !== true) return { ok: false, code: "capability-unsupported", message: "当前 CodeBuddy 运行时未提供图片输入能力，请升级运行时" };
        if (input.mcpEndpoint && initialized.agentCapabilities?.mcpCapabilities?.http !== true) return { ok: false, code: "tools-unavailable", message: "CodeBuddy 未声明 HTTP MCP 能力" };
        // ACP load also accepts the current MCP config, preserving history while rotating authorization.
        sessionId = input.resumeNativeId ?? undefined;
        const session = await rpc(sessionId ? "session/load" : "session/new", { ...(sessionId ? { sessionId } : {}), cwd: input.workDir, mcpServers: input.mcpEndpoint && input.toolToken ? [{ type: "http", name: input.mcpEndpoint.name, url: input.mcpEndpoint.url, headers: [{ name: "Authorization", value: `Bearer ${input.toolToken}` }] }] : [] });
        sessionId = session.sessionId ?? sessionId;
        if (!sessionId) throw new Error("CodeBuddy 未返回会话 id");
        if (input.model) await rpc("session/set_model", { sessionId, modelId: input.model });
        input.onEvidence?.({ transport: "ready" });
        prompting = true;
        const result = await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: input.prompt }, ...(input.images ?? []).map(image => ({ type: "image", mimeType: image.contentType, data: Buffer.from(image.bytes).toString("base64") }))] });
        if (candidateToolViolation) return { ok: false, code: "capability-unsupported", message: "素材生成不允许调用工具" };
        if (result.stopReason === "cancelled") return { ok: false, code: "cancelled", message: "CodeBuddy 回合已取消", nativeId: sessionId };
        if (result.stopReason !== "end_turn") return { ok: false, code: "agent-incomplete", message: `CodeBuddy 回合未完成：${String(result.stopReason)}`, nativeId: sessionId };
        input.onEvidence?.({ credential: "ready" });
        return { ok: true, outcome: { status: "succeeded", assistantText, runId: sessionId }, nativeId: sessionId };
      } catch (error) {
        return { ok: false, code: input.signal.aborted ? "cancelled" : "transport-unavailable", message: error instanceof Error ? error.message : "CodeBuddy 运行失败", ...(sessionId ? { nativeId: sessionId } : {}) };
      } finally {
        if (connectionId) {
          const cleanup = loopbackHttp(input.loopbackUrl, { ...input.httpHeaders, "x-codebuddy-request": "true", "Acp-Connection-Id": connectionId }, AbortSignal.timeout(2000), options.fetchImpl ?? fetch);
          if (signal.aborted && sessionId) await cleanup.request("/api/v1/acp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }) }).then(async response => { await response.body?.cancel(); }).catch(() => undefined);
          await cleanup.request("/api/v1/acp", { method: "DELETE" }).then(async response => { await response.body?.cancel(); }).catch(() => undefined);
        }
        controller.abort();
        signal.removeEventListener("abort", onAbort);
        failPending(new Error("CodeBuddy 连接已关闭"));
        await eventStream;
      }
    }
  };
}
