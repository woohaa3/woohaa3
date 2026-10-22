/** OpenCode 2.x /api API; MCP runtime config belongs to a dedicated location. */
import { setTimeout as delay } from "node:timers/promises";
import { canvasToolName, loopbackHttp, toolResultFailed } from "./loopback-http.js";
import type { LocalAgentTransport, LocalAgentTransportInput, LocalAgentTransportResult } from "./transport.js";

export type HttpTransportOptions = {
  fetchImpl?: typeof globalThis.fetch;
  locationMcpGrantToken?: string | null;
  logger?: (event: Record<string, unknown>) => void;
  /** OpenCode 2.0's runtime tool registry refresh lags behind connected status. */
  catalogSettleMs?: number;
};

export function createOpenCodeTransport(options: HttpTransportOptions = {}): LocalAgentTransport {
  // A location's runtime MCP config is shared. Never rotate its token during another turn.
  const locations = new Map<string, Promise<unknown>>();
  const run = async (input: LocalAgentTransportInput): Promise<LocalAgentTransportResult> => {
    if (!input.loopbackUrl) return { ok: false, code: "runtime-missing", message: "OpenCode 专用进程未启动" };
    if (input.allowedTools.length && (!input.mcpEndpoint || !input.toolToken)) return { ok: false, code: "tools-unavailable", message: "本轮缺少远程 MCP 地址或授权" };
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    const http = loopbackHttp(input.loopbackUrl, input.httpHeaders ?? {}, signal, options.fetchImpl ?? fetch);
    const location = `?${new URLSearchParams({ "location[directory]": input.workDir })}`;
    const mcpPath = input.mcpEndpoint ? `/api/experimental/mcp/${encodeURIComponent(input.mcpEndpoint.name)}${location}` : null;
    let sessionId: string | undefined;
    let installed = false;
    let waiting: Promise<void> | undefined;
    let settled = false;
    let waitError: unknown;
    let assistantText = "";
    let failure: { code: string; message: string } | undefined;
    const textStates = new Map<string, string>();
    const toolStates = new Map<string, string>();
    try {
      const ready = await http.ready("/api/info");
      if (!(ready.headers.get("content-type") ?? "").includes("application/json")) { await ready.body?.cancel(); throw new Error("OpenCode /api/info 未返回 JSON"); }
      const info = await ready.json() as { version?: string };
      if (!/^v?2\./.test(info.version ?? "")) return { ok: false, code: "version-unsupported", message: `需要 OpenCode v2，实际 ${info.version ?? "未知"}` };
      if (mcpPath && input.mcpEndpoint && input.toolToken) {
        // Runtime-only API: URL + per-turn bearer never get written into user configuration.
        installed = true;
        await http.json(mcpPath, "PUT", { config: { type: "remote", url: input.mcpEndpoint.url, headers: { Authorization: `Bearer ${input.toolToken}` }, oauth: false, codemode: false } });
        const deadline = Date.now() + 30_000;
        let status: { status?: string } | undefined;
        do {
          const mcp = await http.json(`/api/mcp${location}`);
          status = mcp.data?.find((entry: { name: string }) => entry.name === input.mcpEndpoint!.name)?.status;
          if (status?.status !== "pending") break;
          await delay(200, undefined, { signal });
        } while (Date.now() < deadline);
        if (status?.status !== "connected") return { ok: false, code: "tools-unavailable", message: `OpenCode 远程 MCP 未连接：${status?.status ?? "未发现"}` };
        // v2.0.32 exposes transport status but no tool-catalog readiness API. Its asynchronous
        // registry can still return an empty tool set immediately after connected. Allow that
        // refresh to settle before invoking a model (verified with the real CLI + local provider).
        await delay(options.catalogSettleMs ?? 1500, undefined, { signal });
      }
      const slash = input.model.indexOf("/");
      if (input.model && slash < 1) return { ok: false, code: "model-access-denied", message: "OpenCode 模型请使用 providerID/modelID 格式" };
      const permissions = [
        { action: "*", resource: "*", effect: "deny" },
        ...input.allowedTools.map(tool => ({ action: `${input.mcpEndpoint?.name}_${tool}`, resource: "*", effect: "allow" }))
      ];
      // A native session can be resumed only in the same frozen context/location.
      const session = input.resumeNativeId
        ? await http.json(`/api/session/${encodeURIComponent(input.resumeNativeId)}`)
        : await http.json("/api/session", "POST", {
        location: { directory: input.workDir },
        title: "WooHaa canvas",
        ...(input.model ? { model: { providerID: input.model.slice(0, slash), id: input.model.slice(slash + 1) } } : {}),
        permissions
      });
      sessionId = session.data?.id;
      if (!sessionId) throw new Error("OpenCode 未返回会话 id");
      if (input.resumeNativeId) await http.json(`/api/session/${encodeURIComponent(sessionId)}`, "PATCH", { permissions });
      if (input.resumeNativeId && input.model) await http.json(`/api/session/${encodeURIComponent(sessionId)}/model`, "POST", { model: { providerID: input.model.slice(0, slash), id: input.model.slice(slash + 1) } });
      input.onEvidence?.({ transport: "ready" });
      const sessionPath = `/api/session/${encodeURIComponent(sessionId)}`;
      const previousMessages = new Set<string>(input.resumeNativeId
        ? (await http.json(`${sessionPath}/message?limit=100&order=desc&type=assistant`)).data?.map((message: { id: string }) => message.id) ?? []
        : []);
      await http.json(`${sessionPath}/prompt`, "POST", { text: input.prompt, ...(input.images?.length ? { files: input.images.map((image, index) => ({ uri: `data:${image.contentType};base64,${Buffer.from(image.bytes).toString("base64")}`, name: `frame-${index}` })) } : {}) });
      // Native idle wait + durable message snapshots avoid relying on a lossy global SSE window.
      waiting = http.request(`/api/experimental/session/${encodeURIComponent(sessionId)}/wait`, { method: "POST", signal })
        .then(async response => { await response.body?.cancel(); }, error => { waitError = error; })
        .finally(() => { settled = true; });
      const project = async () => {
        const messages = await http.json(`${sessionPath}/message?limit=100&order=desc&type=assistant`);
        const texts: string[] = [];
        for (const message of [...(messages.data ?? [])].reverse()) {
          if (previousMessages.has(message.id)) continue;
          if (message.error) failure = { code: message.error.type ?? "agent-failed", message: message.error.message ?? "OpenCode 推理失败" };
          for (const [index, part] of (message.content ?? []).entries()) {
            if (part.type === "text") {
              const key = `${message.id}:${index}`;
              texts.push(part.text);
              if (textStates.get(key) !== part.text) {
                textStates.set(key, part.text);
                input.onEvent({ type: "message", role: "assistant", content: part.text, delivery: "replace", streamId: key });
              }
            } else if (part.type === "tool") {
              const name = canvasToolName(part.name, input.allowedTools);
              const status = part.state?.status;
              if (!toolStates.has(part.id)) input.onEvent({ type: "tool-started", tool: name, callId: part.id });
              if (toolStates.get(part.id) !== status && (status === "completed" || status === "error")) input.onEvent({ type: "tool-completed", tool: name, callId: part.id, ok: status === "completed" && !toolResultFailed(part.state?.content), ...(part.state?.error?.message ? { summary: part.state.error.message } : {}) });
              toolStates.set(part.id, status);
            }
          }
        }
        assistantText = texts.join("\n");
      };
      while (!settled) {
        await project();
        await Promise.race([waiting, delay(400, undefined, { signal })]);
      }
      if (waitError) throw waitError;
      await project();
      const final = await http.json(sessionPath);
      const outcome = final.data?.outcome;
      if (failure) return { ok: false, ...failure, nativeId: sessionId };
      if (outcome !== "succeeded") return { ok: false, code: outcome === "interrupted" ? "cancelled" : "agent-incomplete", message: `OpenCode 回合未成功：${outcome ?? "缺少终态"}`, nativeId: sessionId };
      input.onEvidence?.({ credential: "ready" });
      return { ok: true, outcome: { status: "succeeded", assistantText, runId: sessionId }, nativeId: sessionId };
    } catch (error) {
      return { ok: false, code: input.signal.aborted ? "cancelled" : "transport-unavailable", message: error instanceof Error ? error.message : "OpenCode 运行失败", ...(sessionId ? { nativeId: sessionId } : {}) };
    } finally {
      const cleanup = loopbackHttp(input.loopbackUrl, input.httpHeaders ?? {}, AbortSignal.timeout(3000), options.fetchImpl ?? fetch);
      if (sessionId && !settled) await cleanup.json(`/api/session/${encodeURIComponent(sessionId)}/interrupt`, "POST").catch(() => undefined);
      if (installed && mcpPath) await cleanup.json(mcpPath, "DELETE").catch(() => undefined);
      controller.abort();
      await waiting;
    }
  };
  return {
    id: "opencode-server",
    probe: async () => ({ ok: true }),
    async run(input) {
      const key = input.loopbackUrl ?? "";
      const previous = locations.get(key) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(() => {
        if (input.signal.aborted) return { ok: false as const, code: "cancelled", message: "回合已取消" };
        return run(input);
      });
      locations.set(key, current);
      void current.finally(() => { if (locations.get(key) === current) locations.delete(key); });
      let onAbort = () => {};
      const cancelled = new Promise<LocalAgentTransportResult>(resolve => {
        onAbort = () => resolve({ ok: false, code: "cancelled", message: "回合已取消" });
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener("abort", onAbort, { once: true });
      });
      try { return await Promise.race([current, cancelled]); } finally { input.signal.removeEventListener("abort", onAbort); }
    }
  };
}

export { coerceSseEvents } from "../protocol/sse.js";
