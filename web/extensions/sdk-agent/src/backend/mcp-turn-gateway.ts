/** Per-turn MCP capability membrane; never contains an inference/tool loop. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AgentAdapterRunInput } from "@woohaa3/contracts";
import { createEndpointPolicy, localAgentToolsForMode } from "@woohaa3/agent-connections";
import type { ModelToolDefinition } from "./protocol/model-turn.js";

type Json = Record<string, any>;
function decode(text: string): Json {
  const chunks = text.trim().startsWith("{") ? [text] : text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
  for (const chunk of chunks) { try { const value = JSON.parse(chunk); if (value.result || value.error) return value; } catch {} }
  throw new Error("MCP protocol mismatch");
}

export async function createMcpTurnGateway(options: {
  input: AgentAdapterRunInput; upstream: string; grant: string;
  valid: () => boolean | Promise<boolean>;
  validateTarget?: () => Promise<boolean>;
}) {
  const checked = createEndpointPolicy({ allowedHosts: ["127.0.0.1", "localhost", "::1", "[::1]"], allowHttp: true }).check(options.upstream);
  if (!checked.ok) throw new Error("MCP endpoint must be host loopback");
  const allowed = localAgentToolsForMode(options.input.intent.mode);
  let sequence = 0;
  let closed = false;
  let firstWrite = true;
  const calls = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  const completed = new Map<string, { identity: string; outcome: Promise<Json> }>();
  const receipts: Array<{ canvasId: string; nodeId?: string; commandId: string; revision?: number }> = [];
  const upstreamCall = async (method: string, params?: unknown) => {
    const response = await fetch(options.upstream, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
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
      if (closed || options.input.signal.aborted || !(await options.valid())) return send({ error: "expired" }, 410);
    } catch { return send({ error: "expired" }, 410); }
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
        const name = message.params?.name;
        if (!tools.some((tool) => tool.name === name)) throw new Error("tool-not-allowed");
        const args: Json = { ...(message.params.arguments ?? {}) };
        const target = options.input.intent;
        if (args.canvasId !== undefined && args.canvasId !== options.input.canvasId) throw new Error("target-mismatch");
        const schema = tools.find((tool) => tool.name === name)?.parameters;
        const properties = schema?.properties as Record<string, unknown> | undefined;
        if (properties?.canvasId) args.canvasId = options.input.canvasId;
        if (target.nodeId && target.mode !== "canvas-group") {
          if (args.nodeId !== undefined && args.nodeId !== target.nodeId) throw new Error("target-mismatch");
          if (properties?.nodeId) args.nodeId = target.nodeId;
        }
        for (const field of ["clipId", "itemId", "cameraId"] as const) {
          if (target[field] && args[field] !== undefined && args[field] !== target[field]) throw new Error("target-mismatch");
          if (target[field] && properties?.[field]) args[field] = target[field];
        }
        const write = !name.startsWith("get_");
        if (write && firstWrite) {
          if (options.validateTarget && !(await options.validateTarget())) throw new Error("target-precondition-failed");
          firstWrite = false;
        }
        if (name === "submit_model_scripts") {
          if (!Array.isArray(args.items) || args.items.some((item: Json) => item.nodeId !== target.nodeId)) throw new Error("target-mismatch");
          for (const item of args.items) if (target.expectedContentHash) item.expectedModelContentHash = target.expectedContentHash;
        }
        if (target.expectedContentHash && target.mode === "film-set" && properties?.expectedClipHash) args.expectedClipHash = target.expectedContentHash;
        if (name === "submit_model_script" && target.expectedContentHash) args.expectedModelContentHash = target.expectedContentHash;
        // Each SDK call gets a stable operation identity; transport retries cannot create another write.
        const callId = String(message.id);
        if (properties?.requestId) args.requestId = `${options.input.requestId}:${callId}`;
        const call = { tool: name, callId };
        if (!calls.has(callId)) { calls.add(callId); options.input.emit({ type: "tool-started", ...call }); }
        const identity = JSON.stringify({ name, args });
        if (closed || options.input.signal.aborted || !(await options.valid())) throw new Error("grant-expired");
        const previous = completed.get(callId);
        if (previous && previous.identity !== identity) throw new Error("call-id-conflict");
        if (!previous && completed.size >= 24) throw new Error("tool-budget-exceeded");
        const operation = previous?.outcome ?? upstreamCall("tools/call", { name, arguments: args }).then((outcome) => {
          if (outcome.error) throw new Error("tool-upstream-rejected");
          const evidence = outcome.result?.structuredContent;
          const ok = outcome.result?.isError !== true && evidence?.ok !== false;
          options.input.emit({ type: "tool-completed", ...call, ok });
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
        result = (await operation).result;
      } else throw new Error("method-not-allowed");
      send({ jsonrpc: "2.0", id, result });
    } catch { send({ jsonrpc: "2.0", id, error: { code: -32602, message: "本轮工具请求被拒绝或未能核对" } }); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    tools, token, receipts,
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
