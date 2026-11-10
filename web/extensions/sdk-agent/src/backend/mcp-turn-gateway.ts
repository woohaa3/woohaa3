/** Per-turn MCP capability membrane; never contains an inference/tool loop. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AgentAdapterRunInput } from "@woohaa3/contracts";
import { createEndpointPolicy } from "@woohaa3/agent-connections";
import type { ModelToolDefinition } from "./protocol/model-turn.js";

type Json = Record<string, any>;
function decode(text: string): Json {
  const chunks = text.trim().startsWith("{") ? [text] : text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
  for (const chunk of chunks) { try { const value = JSON.parse(chunk); if (value.result || value.error) return value; } catch {} }
  throw new Error("MCP protocol mismatch");
}

/** 工具过程投影是有界摘要：只保留可行动原因，不搬运完整上游 payload。 */
const DETAIL_LIMIT = 400;
const bounded = (value: string | undefined): string | undefined => {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
};

/** MCP 工具失败的真实原因：优先结构化回执的 code/message，其次可读文本。 */
function resultFailureDetail(result: Json | undefined): string | undefined {
  const structured = result?.structuredContent as Json | undefined;
  const message = typeof structured?.message === "string" ? structured.message : undefined;
  if (message) return bounded(typeof structured?.code === "string" ? `[${structured.code}] ${message}` : message);
  const content = result?.content;
  if (Array.isArray(content)) {
    const text = (content as Json[]).filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text as string).join("\n");
    return bounded(text);
  }
  return undefined;
}

function rpcErrorDetail(error: Json | undefined): string | undefined {
  const message = typeof error?.message === "string" ? error.message : undefined;
  if (!message) return undefined;
  const code = typeof error?.code === "number" || typeof error?.code === "string" ? String(error.code) : undefined;
  return bounded(code ? `[${code}] ${message}` : message);
}

/** 已转成 JSON-RPC 错误的工具拒绝：保留具体原因，外层不再用固定文案覆盖。 */
class ToolCallRejected extends Error {}

export async function createMcpTurnGateway(options: {
  input: AgentAdapterRunInput; upstream: string; grant: string;
  valid: () => boolean | Promise<boolean>;
  validateTarget?: () => Promise<boolean>;
}) {
  const checked = createEndpointPolicy({ allowedHosts: ["127.0.0.1", "localhost", "::1", "[::1]"], allowHttp: true }).check(options.upstream);
  if (!checked.ok) throw new Error("MCP endpoint must be host loopback");
  // 通道只暴露宿主已准备并求交的工具集；不再按业务 mode 选择工具。
  const allowed = options.input.prepared?.tools ?? [];
  // 世界工具使用宿主签发的 scope 身份，nodeId 不是模型操作目标；这是目标语义，不是角色模板。
  const world = options.input.intent.mode === "world";
  let sequence = 0;
  let closed = false;
  let firstWrite = true;
  const calls = new Set<string>();
  // 每个 callId 只结算一次：重试/重复请求不产生第二条完成回执。
  const settled = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  const completed = new Map<string, { identity: string; outcome: Promise<Json> }>();
  const receipts: Array<{ canvasId: string; nodeId?: string; commandId: string; revision?: number }> = [];
  // 模型是否真的尝试过写入：用于把「只读没写」和「写了但没成功」分开归因。
  let attemptedWrites = 0;
  /** 网关真实收到的工具名（含被拒绝的）；用来判断模型声明的调用有没有送达。 */
  const receivedTools = new Set<string>();
  const settle = (call: { tool: string; callId: string }, ok: boolean, summary?: string): void => {
    if (settled.has(call.callId)) return;
    settled.add(call.callId);
    options.input.emit({ type: "tool-completed", ...call, ok, ...(summary ? { summary } : {}) });
  };
  const upstreamCall = async (method: string, params?: unknown) => {
    // 在途工具工作不设应用固定时长；已受理的写入必须排空并登记权威回执，因此这里不把本回合
    // 的取消信号直接绑到单次请求上（取消后由 drain/close 收敛回执，见下面 tools/call 分支）。
    const response = await fetch(options.upstream, {
      method: "POST", redirect: "error",
      headers: { authorization: `Bearer ${options.grant}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, ...(params ? { params } : {}) })
    });
    if (!response.ok) throw new Error("MCP upstream unavailable");
    return decode(await response.text());
  };
  const listed = await upstreamCall("tools/list");
  if (!Array.isArray(listed.result?.tools)) throw new Error("MCP tool discovery failed");
  const registered = listed.result.tools.filter((tool: Json) => typeof tool.name === "string" && allowed.includes(tool.name));
  if (!registered.length) throw new Error("No registered target tools");
  const tools: ModelToolDefinition[] = registered.map((tool: Json) => ({ name: tool.name, description: tool.description ?? tool.name, parameters: tool.inputSchema ?? { type: "object" } }));
  const token = randomBytes(32).toString("base64url");
  const server = createServer(async (request, response) => {
    const send = (value: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    try {
      if (closed || options.input.signal.aborted || !(await options.valid())) return send({ error: "revoked" }, 410);
    } catch { return send({ error: "revoked" }, 410); }
    const bearer = Buffer.from(request.headers.authorization?.replace(/^Bearer /i, "") ?? "");
    const expected = Buffer.from(token);
    if (request.socket.remoteAddress !== "127.0.0.1" || bearer.length !== expected.length || !timingSafeEqual(bearer, expected)) return send({ error: "unauthorized" }, 401);
    if (request.method === "GET" && request.url === "/mcp") { response.writeHead(405); response.end(); return; }
    if (request.method === "DELETE") { response.writeHead(204); response.end(); return; }
    if (request.method !== "POST" || request.url !== "/mcp") return send({ error: "not-found" }, 404);
    let id: unknown = null;
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new Error("request-too-large"); chunks.push(Buffer.from(chunk)); }
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      id = message.id;
      if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") { response.writeHead(202); response.end(); return; }
      let result: unknown;
      if (message.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "woohaa-turn", version: "1" } };
      else if (message.method === "ping") result = {};
      else if (message.method === "tools/list") result = { tools: registered };
      else if (message.method === "tools/call") {
        const name = typeof message.params?.name === "string" ? message.params.name : "tool";
        const callId = String(message.id);
        const call = { tool: name, callId };
        receivedTools.add(name);
        if (!calls.has(callId)) { calls.add(callId); options.input.emit({ type: "tool-started", ...call }); }
        // 每个被拒分支都把真实原因写进完成回执，再以 JSON-RPC 错误返回给模型：
        // 用户看得到失败原因，模型也能据此修正，而不是只收到一句通用拒绝。
        const reject = (reason: string, detail: string): never => {
          const text = `[${reason}] ${detail}`;
          settle(call, false, bounded(text));
          throw new ToolCallRejected(text);
        };
        try {
          if (!tools.some((tool) => tool.name === name)) reject("tool-not-allowed", "本轮没有向助手开放这个工具");
          const args: Json = { ...(message.params.arguments ?? {}) };
          const target = options.input.intent;
          if (args.canvasId !== undefined && args.canvasId !== options.input.canvasId) reject("target-mismatch", "工具参数指定的画布与本轮画布不一致");
          const schema = tools.find((tool) => tool.name === name)?.parameters;
          const properties = schema?.properties as Record<string, unknown> | undefined;
          if (properties?.canvasId) args.canvasId = options.input.canvasId;
          // World tools operate inside a host-issued scope; the scope/card node id is
          // not the model operation target, so it must not be injected as nodeId.
          if (!world && target.nodeId) {
            if (args.nodeId !== undefined && args.nodeId !== target.nodeId) reject("target-mismatch", "工具参数指定的节点与本轮固定目标不一致");
            if (properties?.nodeId) args.nodeId = target.nodeId;
          }
          if (!world) {
            for (const field of ["cameraId"] as const) {
              if (target[field] && args[field] !== undefined && args[field] !== target[field]) reject("target-mismatch", "工具参数指定的镜头与本轮固定目标不一致");
              if (target[field] && properties?.[field]) args[field] = target[field];
            }
          }
          const write = !name.startsWith("get_");
          if (write) attemptedWrites++;
          if (write && firstWrite) {
            if (options.validateTarget && !(await options.validateTarget())) reject("target-precondition-failed", "目标内容已变化，本轮写入前提不成立");
            firstWrite = false;
          }
          if (name === "submit_model_scripts") {
            if (!Array.isArray(args.items) || args.items.some((item: Json) => item.nodeId !== target.nodeId)) reject("target-mismatch", "提交项与本轮固定模型目标不一致");
            for (const item of args.items) if (target.expectedContentHash) item.expectedModelContentHash = target.expectedContentHash;
          }
          if (name === "submit_model_script" && target.expectedContentHash) args.expectedModelContentHash = target.expectedContentHash;
          // Each SDK call gets a stable operation identity; transport retries cannot create another write.
          if (properties?.requestId) args.requestId = `${options.input.requestId}:${callId}`;
          const identity = JSON.stringify({ name, args });
          if (closed || options.input.signal.aborted || !(await options.valid())) reject("grant-revoked", "本轮授权已失效或已停止");
          const previous = completed.get(callId);
          if (previous && previous.identity !== identity) reject("call-id-conflict", "同一调用 id 使用了不同参数");
          // change: 2026-10-22-remove-agent-execution-limits —— 这里原本按 completed.size 达 24
          // 拒绝新 callId。调用次数不是权限：继续用稳定 callId 做幂等去重与回执收敛即可。
          const operation = previous?.outcome ?? upstreamCall("tools/call", { name, arguments: args }).then((outcome) => {
            if (outcome.error) {
              // 上游以 JSON-RPC 错误拒绝：保留原因，不缓存成没有详情的异常。
              settle(call, false, rpcErrorDetail(outcome.error) ?? "[upstream-rejected] 上游工具拒绝本次调用");
              return outcome;
            }
            const evidence = outcome.result?.structuredContent;
            const ok = outcome.result?.isError !== true && evidence?.ok !== false;
            settle(call, ok, ok ? undefined : resultFailureDetail(outcome.result) ?? "工具执行失败，宿主没有返回原因");
            if (write && ok && evidence?.ok === true && typeof evidence.commandId === "string" && evidence.canvasId === options.input.canvasId && !receipts.some((receipt) => receipt.commandId === evidence.commandId)) {
              receipts.push({ canvasId: evidence.canvasId, ...(typeof evidence.nodeId === "string" ? { nodeId: evidence.nodeId } : {}), commandId: evidence.commandId, ...(typeof evidence.revision === "number" ? { revision: evidence.revision } : {}) });
            }
            return outcome;
          });
          if (!previous) {
            completed.set(callId, { identity, outcome: operation });
            pending.add(operation);
            void operation.finally(() => pending.delete(operation)).catch(() => undefined);
          }
          const outcome = await operation;
          if (outcome.error) throw new ToolCallRejected(rpcErrorDetail(outcome.error) ?? "[upstream-rejected] 上游工具拒绝本次调用");
          result = outcome.result;
        } catch (error) {
          if (!(error instanceof ToolCallRejected)) settle(call, false, bounded(`[invalid-request] ${error instanceof Error ? error.message : "工具调用未完成"}`));
          throw error;
        }
      } else throw new Error("method-not-allowed");
      send({ jsonrpc: "2.0", id, result });
    } catch (error) {
      const message = error instanceof ToolCallRejected ? error.message : `[invalid-request] ${error instanceof Error ? error.message : "工具请求无效"}`;
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: bounded(message) ?? "工具请求被拒绝" } });
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    tools, token, receipts,
    /** 本轮模型发起过的写工具调用次数（含被拒绝的）。 */
    get attemptedWrites() { return attemptedWrites; },
    /** 网关真实收到的工具名；模型声明了却没出现在这里的调用没有送达执行端。 */
    get receivedTools() { return [...receivedTools]; },
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    drain: async () => { await Promise.allSettled([...pending]); },
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...pending]);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
