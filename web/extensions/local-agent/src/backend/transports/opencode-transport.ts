/** OpenCode 2.x /api API; MCP runtime config belongs to a dedicated location. */
import { setTimeout as delay } from "node:timers/promises";
import { isAgentReasoningEffort, type AgentModelView, type AgentReasoningEffort } from "@woohaa3/contracts";
import { canvasToolName, loopbackHttp, toolResultFailed } from "./loopback-http.js";
import type { LocalAgentTransport, LocalAgentTransportInput, LocalAgentTransportModelInput, LocalAgentTransportResult } from "./transport.js";

/**
 * 分页读取一个会话的全部 assistant 消息（change: 2026-10-22-remove-agent-execution-limits，
 * 任务 4.1）。
 *
 * 原生快照不再取「最近 100 条」：分页只是单次传输量，完整历史可继续读取。页内按时间升序返回，
 * 调用方据此保持真实顺序。
 */
type OpenCodeMessage = {
  id: string;
  error?: { type?: string; message?: string };
  content?: Array<{
    type?: string;
    text?: string;
    name?: string;
    id?: string;
    state?: { status?: string; content?: unknown; error?: { message?: string } };
  }>;
};

/** `GET /api/model` 目录项；模型身份是 `providerID/modelID`，运行时按首个 `/` 拆分。 */
type OpenCodeModelEntry = {
  modelID?: unknown;
  providerID?: unknown;
  name?: unknown;
  enabled?: unknown;
  variants?: unknown;
};

/**
 * 把 OpenCode 目录映射成助手目录项。
 *
 * OpenCode 的 variant id 与 `AgentReasoningEffort` 取值一致，但也会出现非推理 variant；
 * 只保留宿主认识的取值，避免把任意字符串当成 Variant 传回上游。目录经常混有多个 provider，
 * 显示名统一带来源——下拉、触发器与搜索都只读 label，不再靠同名去重才补 provider。
 */
function openCodeModelDirectory(entries: readonly OpenCodeModelEntry[]): AgentModelView[] {
  const catalog = new Map<string, AgentModelView>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || entry.enabled === false) continue;
    const providerID = typeof entry.providerID === "string" ? entry.providerID.trim() : "";
    const modelID = typeof entry.modelID === "string" ? entry.modelID.trim() : "";
    if (!providerID || !modelID) continue;
    const id = `${providerID}/${modelID}`;
    const reasoningEfforts: AgentReasoningEffort[] = [];
    for (const variant of Array.isArray(entry.variants) ? entry.variants : []) {
      const variantId = variant && typeof variant === "object" ? (variant as { id?: unknown }).id : undefined;
      if (isAgentReasoningEffort(variantId) && !reasoningEfforts.includes(variantId)) reasoningEfforts.push(variantId);
    }
    const name = typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : modelID;
    catalog.set(id, { id, label: `${name} (${providerID})`, ...(reasoningEfforts.length ? { reasoningEfforts } : {}) });
  }
  return [...catalog.values()];
}

async function readAllAssistantMessages(
  http: { json: (path: string) => Promise<{ data?: OpenCodeMessage[] }> },
  sessionPath: string
): Promise<OpenCodeMessage[]> {
  const pageSize = 200;
  const collected: OpenCodeMessage[] = [];
  const seen = new Set<string>();
  for (let offset = 0; ; offset += pageSize) {
    const response = await http.json(`${sessionPath}/message?limit=${pageSize}&offset=${offset}&order=asc&type=assistant`);
    const page = response.data ?? [];
    for (const message of page) if (message.id && !seen.has(message.id)) { seen.add(message.id); collected.push(message); }
    if (page.length < pageSize) break;
  }
  return collected;
}

export type HttpTransportOptions = {
  fetchImpl?: typeof globalThis.fetch;
  locationMcpGrantToken?: string | null;
  logger?: (event: Record<string, unknown>) => void;
  /** OpenCode 2.0's runtime tool registry refresh lags behind connected status. */
  catalogSettleMs?: number;
  /** 模型目录读取期限；目录只是一次只读查询，不与推理回合共享在途期限。 */
  modelCatalogTimeoutMs?: number;
  /** 空目录/暂时失败的读取重试间隔（默认 400ms，共 8 次）。 */
  modelCatalogRetryMs?: number;
};

export function createOpenCodeTransport(options: HttpTransportOptions = {}): LocalAgentTransport {  // A location's runtime MCP config is shared. Never rotate its token during another turn.
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
      // change: 2026-10-22-remove-agent-execution-limits，任务 4.1：原「最近 100 条 assistant
      // 消息」的整体截断已删除。历史基线按分页完整读取，不把长会话的第 100 条以外记录当成不存在。
      const previousMessages = new Set<string>(input.resumeNativeId
        ? (await readAllAssistantMessages(http, sessionPath)).map((message: { id: string }) => message.id)
        : []);
      await http.json(`${sessionPath}/prompt`, "POST", { text: input.prompt, ...(input.images?.length ? { files: input.images.map((image, index) => ({ uri: `data:${image.contentType};base64,${Buffer.from(image.bytes).toString("base64")}`, name: `frame-${index}` })) } : {}) });
      // Native idle wait + durable message snapshots avoid relying on a lossy global SSE window.
      waiting = http.request(`/api/experimental/session/${encodeURIComponent(sessionId)}/wait`, { method: "POST", signal })
        .then(async response => { await response.body?.cancel(); }, error => { waitError = error; })
        .finally(() => { settled = true; });
      const project = async () => {
        const messages = { data: await readAllAssistantMessages(http, sessionPath) };
        const texts: string[] = [];
        for (const message of messages.data) {
          if (previousMessages.has(message.id)) continue;
          if (message.error) failure = { code: message.error.type ?? "agent-failed", message: message.error.message ?? "OpenCode 推理失败" };
          for (const [index, part] of (message.content ?? []).entries()) {
            if (part.type === "text") {
              const key = `${message.id}:${index}`;
              const text = part.text ?? "";
              texts.push(text);
              if (textStates.get(key) !== text) {
                textStates.set(key, text);
                input.onEvent({ type: "message", role: "assistant", content: text, delivery: "replace", streamId: key });
              }
            } else if (part.type === "tool") {
              const name = canvasToolName(part.name ?? "unknown", input.allowedTools);
              const status = part.state?.status;
              const partId = part.id ?? `${message.id}:tool:${index}`;
              if (!toolStates.has(partId)) input.onEvent({ type: "tool-started", tool: name, callId: part.id });
              if (toolStates.get(partId) !== status && (status === "completed" || status === "error")) input.onEvent({ type: "tool-completed", tool: name, callId: part.id, ok: status === "completed" && !toolResultFailed(part.state?.content), ...(part.state?.error?.message ? { summary: part.state.error.message } : {}) });
              toolStates.set(partId, status ?? "unknown");
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
    async models(input: LocalAgentTransportModelInput) {
      if (!input.loopbackUrl) return { models: [], error: "OpenCode 专用进程未启动" };
      const signal = AbortSignal.timeout(options.modelCatalogTimeoutMs ?? 20_000);
      const http = loopbackHttp(input.loopbackUrl, input.httpHeaders ?? {}, signal, options.fetchImpl ?? fetch);
      try {
        const ready = await http.ready("/api/info");
        if (!(ready.headers.get("content-type") ?? "").includes("application/json")) {
          await ready.body?.cancel();
          throw new Error("OpenCode /api/info 未返回 JSON");
        }
        const info = await ready.json() as { version?: string };
        if (!/^v?2\./.test(info.version ?? "")) return { models: [], error: `需要 OpenCode v2，实际 ${info.version ?? "未知"}` };
        // 模型目录按 location 解析：v2 不带 `location[directory]` 时返回空数组，而不是全部模型。
        const location = `?${new URLSearchParams({ "location[directory]": input.workDir })}`;
        // 进程刚启动时该 location 的目录索引仍在异步加载，首次读取会返回空数组；回合进行中也可能
        // 短暂为空。按固定间隔重试一段有界窗口，而不是把「还没加载完」当成「没有模型」——否则下拉
        // 在第一次打开时就空着，而目录缓存又会把这个空结果保留一分钟。
        const attempts = 8;
        const retryMs = options.modelCatalogRetryMs ?? 400;
        let error = "OpenCode 未返回可用模型，请先在 OpenCode 中登录或配置 provider";
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          try {
            const response = await http.json(`/api/model${location}`);
            const models = openCodeModelDirectory(Array.isArray(response.data) ? response.data : []);
            if (models.length) return { models };
            error = "OpenCode 未返回可用模型，请先在 OpenCode 中登录或配置 provider";
          } catch (cause) {
            error = cause instanceof Error ? cause.message : "OpenCode 模型目录读取失败";
            // 认证/路由类 4xx 是确定性失败，重试只会拖慢错误反馈。
            if (/HTTP 4\d\d/.test(error)) return { models: [], error };
          }
          if (attempt + 1 < attempts) await delay(retryMs, undefined, { signal });
        }
        return { models: [], error };
      } catch (error) {
        return { models: [], error: error instanceof Error ? error.message : "OpenCode 模型目录读取失败" };
      }
    },
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
