import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { AgentAdapterRunInput } from "@woohaa3/contracts";
import { createMcpTurnGateway } from "./mcp-turn-gateway.js";
import { buildTestPreparedTurn } from "@woohaa3/test-fixtures-agent-role-turns";

async function fixture(validate = true, writeBarrier?: Promise<void>, onWrite?: () => void) {
  const received: Array<{ method: string; params?: any; authorization?: string }> = [];
  const upstream = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const message = JSON.parse(text);
    received.push({ ...message, authorization: req.headers.authorization });
    const result = message.method === "tools/list" ? { tools: [
      { name: "get_model_node", inputSchema: { type: "object" } },
      { name: "submit_model_script", inputSchema: { type: "object", properties: { canvasId: {}, nodeId: {}, requestId: {}, expectedModelContentHash: {} } } },
      { name: "shell", inputSchema: { type: "object" } }
    ] } : { content: [{ type: "text", text: "done" }], structuredContent: { ok: true, commandId: "cmd-1", canvasId: "canvas", nodeId: "node", revision: 2 } };
    if (message.method === "tools/call") { onWrite?.(); await writeBarrier; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const controller = new AbortController(); let valid = true;
  const emit = vi.fn();
  const input = { owner: "owner", requestId: "request", canvasId: "canvas", conversationId: "conversation", turnId: "turn", history: [], signal: controller.signal, emit,
    intent: { action: "modify", canvasId: "canvas", nodeId: "node", mode: "model3d", prompt: "update", expectedContentHash: "hash" },
    prepared: buildTestPreparedTurn({ requestId: "request", target: { canvasId: "canvas", nodeId: "node", mode: "model3d" }, prompt: "update", tools: ["get_model_node", "submit_model_script"] }) } as AgentAdapterRunInput;
  const validateTarget = vi.fn(async () => validate);
  const gateway = await createMcpTurnGateway({ input, upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp`, grant: "real-grant", valid: () => valid, validateTarget });
  const call = async (name: string, args: Record<string, unknown> = {}, id = 1, token = gateway.token) => {
    const response = await fetch(gateway.url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) });
    return { status: response.status, body: await response.json() };
  };
  return { gateway, received, call, validateTarget, emit, controller, invalidate: () => { valid = false; }, close: async () => { await gateway.close(); upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve())); } };
}
describe("每轮 MCP 授权与权威回执", () => {
  it("只公开真实目标工具；秘密替换、目标冻结与重复调用幂等", async () => {
    const f = await fixture();
    try {
      expect(f.gateway.tools.map((t) => t.name)).toEqual(["get_model_node", "submit_model_script"]);
      expect((await f.call("shell")).body).toHaveProperty("error");
      expect((await f.call("submit_model_script", { nodeId: "other" })).body).toHaveProperty("error");
      expect((await f.call("submit_model_script", { script: "model" })).body).toHaveProperty("result");
      await f.call("submit_model_script", { script: "model" });
      const writes = f.received.filter((r) => r.method === "tools/call");
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ authorization: "Bearer real-grant", params: { name: "submit_model_script", arguments: { canvasId: "canvas", nodeId: "node", requestId: "request:1", expectedModelContentHash: "hash" } } });
      expect(f.gateway.receipts).toEqual([{ canvasId: "canvas", nodeId: "node", commandId: "cmd-1", revision: 2 }]);
      expect(f.validateTarget).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });
  it("错误凭据、旧代次与停止后均不能调用上游", async () => {
    const f = await fixture();
    try {
      expect((await f.call("get_model_node", {}, 1, "wrong")).status).toBe(401);
      f.invalidate();
      expect((await f.call("get_model_node")).status).toBe(410);
      f.controller.abort();
      expect((await f.call("submit_model_script")).status).toBe(410);
      expect(f.received.filter((r) => r.method === "tools/call")).toEqual([]);
    } finally { await f.close(); }
  });
  it("内容前提冲突在首次写入前拒绝，不能用框架结束冒充回执", async () => {
    const f = await fixture(false);
    try {
      expect((await f.call("submit_model_script")).body).toHaveProperty("error");
      expect(f.gateway.receipts).toEqual([]);
      expect(f.received.filter((r) => r.method === "tools/call")).toEqual([]);
    } finally { await f.close(); }
  });
  it("停止后排空已经受理的写入，先登记权威回执再结束 drain", async () => {
    let release!: () => void;
    let accepted!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { accepted = resolve; });
    const f = await fixture(true, barrier, accepted);
    try {
      const call = f.call("submit_model_script");
      await started;
      f.controller.abort();
      let drained = false;
      const drain = f.gateway.drain().then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      release();
      await drain;
      expect(f.gateway.receipts).toEqual([{ canvasId: "canvas", nodeId: "node", commandId: "cmd-1", revision: 2 }]);
      await call;
      expect((await f.call("submit_model_script", {}, 2)).status).toBe(410);
      expect(f.received.filter((item) => item.method === "tools/call")).toHaveLength(1);
    } finally { release(); await f.close(); }
  });

  it("超过原 24 次工具调用仍执行，callId 幂等且重复不重复触发上游 (task 2.2)", async () => {
    // change: 2026-10-22-remove-agent-execution-limits：原 completed.size>=24 的
    // tool-budget-exceeded 门禁已删除；稳定 callId 仍保证幂等与回执收敛。
    const f = await fixture();
    try {
      for (let id = 1; id <= 40; id++) expect((await f.call("get_model_node", {}, id)).body).toHaveProperty("result");
      // 相同 callId + 相同参数：复用原结果，不重复触达上游。
      expect((await f.call("get_model_node", {}, 1)).body).toHaveProperty("result");
      expect(f.received.filter((item) => item.method === "tools/call")).toHaveLength(40);
      // 相同 callId + 不同参数仍然冲突。
      expect((await f.call("submit_model_script", {}, 1)).body).toHaveProperty("error");
    } finally { await f.close(); }
  });

});
