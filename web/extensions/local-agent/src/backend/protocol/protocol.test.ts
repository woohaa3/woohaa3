/**
 * 本机来源协议编解码测试（本地协议模拟；不启动真实进程）
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 4.1/6.1/6.3 验收）。
 *
 * 覆盖：Codex App Server JSONL 帧与事件映射；OpenCode v2 健康/事件/窗口丢失；CodeBuddy ACP
 * 握手与写工具轮换 fail closed。
 */
import { describe, expect, it, vi } from "vitest";
import { createJsonRpcLineParser, request, initializeRequest, checkInitializeResult, accountReadyFromResult, createCodexAppServerDecoder, planThreadResume, threadIdFromResult, parseModelListResult } from "./codex-appserver.js";
import { parseOpenCodeHealth, createOpenCodeEventDecoder, assertOpencodeToolScope, messageRequest } from "./opencode-http.js";
import { parseCodeBuddyHandshake, assertCodeBuddyWriteScope, acpTurnRequest, createAcpEventDecoder } from "./codebuddy-acp.js";

describe("Codex App Server stdio JSON-RPC（任务 4.1/4.2）", () => {
  it("JSONL 帧解析跨分片，非 JSON 行报错", () => {
    const parser = createJsonRpcLineParser();
    expect(parser.push('{"id":1,"result":')).toEqual([]);
    const out = parser.push('{}}\nnot-json\n{"method":"x"}\n');
    expect(out[0]).toEqual({ message: { id: 1, result: {} } });
    expect(out[1]).toEqual({ error: "JSON-RPC 帧不是合法 JSON" });
    expect(out[2]).toEqual({ message: { method: "x" } });
  });

  it("initialize 请求形状与版本校验（不匹配明确拒绝）", () => {
    const req = initializeRequest(1, { clientName: "woohaa3", clientVersion: "0.1.0", protocolVersion: "2025-06-18" });
    expect(req).toMatchObject({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect((req.params as Record<string, unknown>).protocolVersion).toBe("2025-06-18");
    expect(checkInitializeResult({ protocolVersion: "2025-06-18" }, "2025-06-18")).toEqual({ ok: true });
    const mismatch = checkInitializeResult({ protocolVersion: "2024-01-01" }, "2025-06-18");
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.code).toBe("protocol-mismatch");
  });

  it("账号状态按当前 Account.type 判定；未登录不标 ready", () => {
    expect(accountReadyFromResult({ account: { type: "chatgpt", email: null, planType: "plus" } })).toEqual({ ready: true });
    expect(accountReadyFromResult({ account: { type: "apiKey" } })).toEqual({ ready: true });
    expect(accountReadyFromResult({ account: { type: "amazonBedrock", usesCodexManagedCredentials: true } })).toEqual({ ready: true });
    // 兼容旧版形状。
    expect(accountReadyFromResult({ account: { status: "ready" } })).toEqual({ ready: true });
    // 自定义 provider（Bearer gateway）不需要 OpenAI 账号，不能误报未登录。
    expect(accountReadyFromResult({ account: null, requiresOpenaiAuth: false })).toEqual({ ready: true });
    const notReady = accountReadyFromResult({ account: null, requiresOpenaiAuth: true });
    expect(notReady.ready).toBe(false);
    expect(notReady.reason).toContain("尚未登录");
  });

  it("线程 id 从 thread/start 的嵌套 thread.id 提取；缺失时明确返回 null", () => {
    expect(threadIdFromResult({ thread: { id: "th_nested" } })).toBe("th_nested");
    expect(threadIdFromResult({ threadId: "th_flat" })).toBe("th_flat");
    expect(threadIdFromResult({ id: "th_legacy" })).toBe("th_legacy");
    expect(threadIdFromResult({ thread: {} }, "resume-id")).toBe("resume-id");
    expect(threadIdFromResult({}, null)).toBeNull();
  });

  it("模型目录投影使用 displayName，过滤 hidden，并保留分页游标", () => {
    expect(parseModelListResult({
      data: [
        { id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "GPT-6.1-Sol" },
        { id: "hidden-model", displayName: "Hidden", hidden: true }
      ],
      nextCursor: "next"
    })).toEqual({ models: [{ id: "gpt-6.1-sol", label: "GPT-6.1-Sol" }], nextCursor: "next" });
  });

  it("事件映射：助手文本、MCP 工具过程与终态", () => {
    const decoder = createCodexAppServerDecoder();
    const started = decoder.onMessage({ method: "thread/started", params: { thread: { id: "th_1" } } });
    expect(started).toEqual([{ type: "stage", stage: "thread-started" }]);
    const delta = decoder.onMessage({ method: "item/agentMessage/delta", params: { delta: "你好" } });
    const deltaStreamId = (delta[1] as { streamId?: string }).streamId;
    expect(delta).toEqual([{ type: "stage", stage: "responding" }, { type: "message", role: "assistant", content: "你好", delivery: "append", streamId: expect.any(String) }]);
    // 同一条消息的完成项沿用增量流的身份（以 replace 收敛，不新增一条）。
    const finishedMessage = decoder.onMessage({ method: "item/completed", params: { item: { type: "agent_message", id: "m1", text: "你好世界" } } });
    expect(finishedMessage).toEqual([{ type: "message", role: "assistant", content: "你好世界", delivery: "replace", streamId: deltaStreamId }]);
    // 下一条消息另开身份。
    const nextDelta = decoder.onMessage({ method: "item/agentMessage/delta", params: { delta: "再来" } });
    expect((nextDelta[0] as { streamId?: string }).streamId).not.toBe(deltaStreamId);
    const startedTool = decoder.onMessage({ method: "item/started", params: { item: { type: "mcpToolCall", name: "submit_model_script", id: "c1" } } });
    expect(startedTool).toEqual([{ type: "tool-started", tool: "submit_model_script", callId: "c1" }]);
    const completedTool = decoder.onMessage({ method: "item/completed", params: { item: { type: "mcpToolCall", name: "submit_model_script", id: "c1", status: "completed", result: { content: [] } } } });
    expect(completedTool).toEqual([{ type: "tool-completed", tool: "submit_model_script", ok: true, summary: "完成", callId: "c1" }]);
    const wrapped = decoder.onMessage({
      method: "item/completed",
      params: {
        item: {
          type: "customToolCall",
          name: "exec",
          call_id: "c2",
          input: 'const result = await tools.mcp__woohaa__get_model_node({canvasId:"cv", nodeId:"n1"}); text(result);'
        }
      }
    });
    expect(wrapped).toEqual([{ type: "tool-started", tool: "get_model_node", callId: "c2" }]);
    // 只投影受控 MCP 调用；exec 的探测脚本不产生工具事件。
    const probe = decoder.onMessage({
      method: "item/completed",
      params: { item: { type: "customToolCall", name: "exec", input: "const matches = ALL_TOOLS.filter(x => /scene/.test(x.name)); text(matches);" } }
    });
    expect(probe).toEqual([]);
    decoder.onMessage({ method: "turn/completed", params: {} });
    const outcome = decoder.finish();
    expect(outcome.status).toBe("succeeded");
    expect(outcome.receipt).toMatchObject({ toolCount: 2 });
    expect(outcome.runId).toBe("th_1");
    expect(decoder.threadId()).toBe("th_1");
  });

  it("失败工具项保留真实原因（结构化 code/message），不用无信息量的“失败”", () => {
    const decoder = createCodexAppServerDecoder();
    decoder.onMessage({ method: "item/started", params: { item: { type: "mcpToolCall", name: "get_world_model_rig", id: "c9" } } });
    const failed = decoder.onMessage({
      method: "item/completed",
      params: {
        item: {
          type: "mcpToolCall",
          name: "get_world_model_rig",
          id: "c9",
          status: "failed",
          result: { isError: true, structuredContent: { ok: false, code: "not-ready", message: "模型 m1 的动画部件无法编译" } }
        }
      }
    });
    expect(failed).toEqual([{ type: "tool-completed", tool: "get_world_model_rig", ok: false, summary: "[not-ready] 模型 m1 的动画部件无法编译", callId: "c9" }]);
  });

  it("streams only public summaries, coalesces deltas and flushes the final section", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(20_000);
    try {
      const decoder = createCodexAppServerDecoder();
      const delta = (summaryIndex: number, text: string) => decoder.onMessage({ method: "item/reasoning/summaryTextDelta", params: { itemId: "r1", summaryIndex, delta: text } });
      expect(delta(0, "分析主体")).toEqual([{ type: "stage", stage: "reasoning", summary: "分析主体" }]);
      expect(delta(0, "比例")).toEqual([]);
      clock.mockReturnValue(21_000);
      expect(delta(1, "规划对象")).toEqual([{ type: "stage", stage: "reasoning", summary: "分析主体比例\n\n规划对象" }]);
      expect(delta(1, "和布局")).toEqual([]);
      expect(decoder.onMessage({ method: "item/completed", params: { item: { id: "r1", type: "reasoning", text: "raw-secret" } } }))
        .toEqual([{ type: "stage", stage: "reasoning", summary: "分析主体比例\n\n规划对象和布局" }]);
      clock.mockReturnValue(32_000);
      expect(decoder.onMessage({ method: "item/reasoning/textDelta", params: { delta: "raw-secret" } }))
        .toEqual([{ type: "stage", stage: "reasoning" }]);
      expect(delta(0, "")).toEqual([]);
      expect(decoder.onMessage({ method: "item/completed", params: { item: { id: "r2", type: "reasoning", summary: ["恢复后的公开摘要"], content: ["raw-secret"] } } }))
        .toEqual([{ type: "stage", stage: "reasoning", summary: "恢复后的公开摘要" }]);
      expect(decoder.finish().assistantText).toBe("");
    } finally { clock.mockRestore(); }
  });

  it("projects real reasoning activity without its contents and keeps the public reply stream", () => {
    const decoder = createCodexAppServerDecoder();
    expect(decoder.onMessage({ method: "turn/started", params: {} })).toEqual([{ type: "stage", stage: "running" }]);
    const reasoning = { method: "item/started", params: { item: { type: "reasoning", text: "private", summary: ["private"] } } };
    expect(decoder.onMessage(reasoning)).toEqual([{ type: "stage", stage: "reasoning" }]);
    expect(decoder.onMessage(reasoning)).toEqual([]);
    expect(decoder.onMessage({ method: "item/reasoning/textDelta", params: { delta: "private" } })).toEqual([]);
    expect(decoder.onMessage({ method: "item/agentMessage/delta", params: { delta: "public" } })).toEqual([
      { type: "stage", stage: "responding" },
      { type: "message", role: "assistant", content: "public", delivery: "append", streamId: expect.any(String) }
    ]);
    decoder.onMessage({ method: "turn/completed", params: { turn: { status: "completed" } } });
    expect(decoder.finish()).toMatchObject({ status: "succeeded", assistantText: "public" });
  });

  it("keeps retryable reconnect errors active until the final turn outcome", async () => {
    const decoder = createCodexAppServerDecoder();
    let settled = false;
    void decoder.settled.then(() => { settled = true; });
    decoder.onMessage({ method: "error", params: { willRetry: true, error: { message: "Reconnecting... 1/5" } } });
    await Promise.resolve();
    expect(settled).toBe(false);
    decoder.onMessage({ method: "item/agentMessage/delta", params: { delta: "Recovered" } });
    decoder.onMessage({ method: "turn/completed", params: { turn: { status: "completed", error: null } } });
    await decoder.settled;
    expect(decoder.finish()).toMatchObject({ status: "succeeded", assistantText: "Recovered" });
  });

  it("uses the final failed or interrupted status carried by turn/completed", () => {
    const failed = createCodexAppServerDecoder();
    failed.onMessage({ method: "error", params: { willRetry: true, error: { message: "Reconnecting... 1/5" } } });
    failed.onMessage({ method: "turn/completed", params: { turn: { status: "failed", error: { message: "Stream disconnected", codexErrorInfo: "internalServerError" } } } });
    expect(failed.finish()).toMatchObject({ status: "failed", error: { code: "internalServerError", message: "Stream disconnected" } });
    const interrupted = createCodexAppServerDecoder();
    interrupted.onMessage({ method: "turn/completed", params: { turn: { status: "interrupted", error: null } } });
    expect(interrupted.finish()).toEqual({ status: "cancelled" });
  });

  it("preserves terminal error notifications when retry is false or absent", async () => {
    for (const willRetry of [false, undefined]) {
      const decoder = createCodexAppServerDecoder();
      decoder.onMessage({ method: "error", params: { willRetry, error: { code: "connection-failed", message: "Retries exhausted" } } });
      await decoder.settled;
      expect(decoder.finish()).toMatchObject({ status: "failed", error: { code: "connection-failed", message: "Retries exhausted" } });
    }
  });

  it("turn/failed 映射为 failed，取消映射为 cancelled", () => {
    const decoder = createCodexAppServerDecoder();
    decoder.onMessage({ method: "turn/failed", params: { error: { code: "model_error", message: "boom" } } });
    expect(decoder.finish()).toMatchObject({ status: "failed", error: { code: "model_error" } });

    const cancelling = createCodexAppServerDecoder();
    expect(cancelling.finish({ cancelled: true })).toEqual({ status: "cancelled" });
  });

  it("MCP grant 轮换计划：先 unsubscribe 再以新 grant resume 同一 thread", () => {
    const changed = planThreadResume({ threadId: "th_1", activeGrant: "g1", nextGrant: "g2", baseParams: { model: "m" } });
    expect(changed.steps.map((step) => step.method)).toEqual(["thread/unsubscribe", "thread/resume"]);
    expect(changed.steps[0]!.params).toEqual({ threadId: "th_1" });
    expect(changed.steps[1]!.params).toMatchObject({ threadId: "th_1", model: "m" });

    // grant 不变：不额外 unsubscribe（避免丢失事件流）。
    const unchanged = planThreadResume({ threadId: "th_1", activeGrant: "g1", nextGrant: "g1" });
    expect(unchanged.steps.map((step) => step.method)).toEqual(["thread/resume"]);

    // 无旧订阅：直接 resume。
    const fresh = planThreadResume({ threadId: "th_1", activeGrant: null, nextGrant: "g1" });
    expect(fresh.steps.map((step) => step.method)).toEqual(["thread/resume"]);
  });
});

describe("OpenCode HTTP + SSE（任务 6.1/6.2）", () => {
  it("健康检查要求 v2；非 JSON/旧版本明确拒绝", () => {
    expect(parseOpenCodeHealth(200, "application/json", JSON.stringify({ version: "2.1.0" }))).toMatchObject({ ok: true, major: 2 });
    expect(parseOpenCodeHealth(200, "text/html", "<html>")).toMatchObject({ ok: false, code: "protocol-mismatch" });
    expect(parseOpenCodeHealth(200, "application/json", JSON.stringify({ version: "1.0.0" }))).toMatchObject({ ok: false, code: "version-unsupported" });
    expect(parseOpenCodeHealth(404, "application/json", "{}")).toMatchObject({ ok: false, code: "runtime-missing" });
  });

  it("会话与消息请求形状", () => {
    expect(messageRequest("s1", "hi").path).toBe("/session/s1/message");
    expect(JSON.stringify(messageRequest("s1", "hi").body)).toContain('"type":"text"');
  });

  it("事件解码：文本与工具过程，session.idle 终态", () => {
    const decoder = createOpenCodeEventDecoder();
    decoder.onEvent({ event: "message", data: JSON.stringify({ type: "session.created", properties: { info: { id: "sess_1" } } }) });
    const text = decoder.onEvent({ event: "message", data: JSON.stringify({ type: "message.part.updated", properties: { part: { type: "text", text: "hello" } } }) });
    expect(text).toEqual([{ type: "message", role: "assistant", content: "hello", delivery: "replace", streamId: expect.any(String) }]);
    const tool = decoder.onEvent({ event: "message", data: JSON.stringify({ type: "message.part.updated", properties: { part: { type: "tool", tool: "write_node", state: "completed" } } }) });
    expect(tool).toEqual([{ type: "tool-completed", tool: "write_node", ok: true }]);
    decoder.onEvent({ event: "message", data: JSON.stringify({ type: "session.idle" }) });
    expect(decoder.finish()).toMatchObject({ status: "succeeded", assistantText: "hello", runId: "sess_1" });
  });

  it("OpenCode 同一 text part 的多次累计更新复用同一 streamId（不裂成多条消息）", () => {
    const decoder = createOpenCodeEventDecoder();
    const frame = (text: string) => decoder.onEvent({
      event: "message",
      data: JSON.stringify({ type: "message.part.updated", properties: { part: { type: "text", id: "part_1", text } } })
    });
    const first = frame("你");
    const second = frame("你好");
    expect(first[0]).toMatchObject({ delivery: "replace" });
    const firstId = (first[0] as { streamId?: string }).streamId;
    expect((second[0] as { streamId?: string }).streamId).toBe(firstId);
    // 另一个 part 才开新消息。
    const other = decoder.onEvent({
      event: "message",
      data: JSON.stringify({ type: "message.part.updated", properties: { part: { type: "text", id: "part_2", text: "另一段" } } })
    });
    expect((other[0] as { streamId?: string }).streamId).not.toBe(firstId);
  });

  it("无 part id 的累计快照按前缀延续同一消息；全新正文才开新消息", () => {
    const decoder = createOpenCodeEventDecoder();
    const frame = (text: string) => decoder.onEvent({
      event: "message",
      data: JSON.stringify({ type: "message.part.updated", properties: { part: { type: "text", text } } })
    });
    const first = frame("一步");
    const grown = frame("一步一步");
    expect((grown[0] as { streamId?: string }).streamId).toBe((first[0] as { streamId?: string }).streamId);
    // 与上一条无前缀关系的正文属于下一条消息。
    const next = frame("完成");
    expect((next[0] as { streamId?: string }).streamId).not.toBe((first[0] as { streamId?: string }).streamId);
  });

  it("事件窗口丢失标记 partial，不冒充成功", () => {
    const decoder = createOpenCodeEventDecoder();
    decoder.onEvent({ event: "message", data: JSON.stringify({ type: "message.part.updated", properties: { part: { type: "text", text: "half" } } }) });
    decoder.markResync();
    const outcome = decoder.finish();
    expect(outcome.status).toBe("partial");
    expect(outcome.error?.code).toBe("event-window-lost");
  });

  it("OpenCode 写能力判定：默认不限制写入，显式开启 enforceLocationMatch 时核对", () => {
    expect(assertOpencodeToolScope({ requestedTools: [], locationMcpGrantToken: null, turnGrantToken: null })).toEqual({ ok: true });
    // 默认不限制写入
    expect(assertOpencodeToolScope({ requestedTools: ["write_node"], locationMcpGrantToken: "old", turnGrantToken: "new" })).toEqual({ ok: true });
    expect(assertOpencodeToolScope({ requestedTools: ["write_node"], locationMcpGrantToken: null, turnGrantToken: null })).toEqual({ ok: true });

    // 显式开启 enforceLocationMatch 校验
    const denied = assertOpencodeToolScope({ requestedTools: ["write_node"], locationMcpGrantToken: "old", turnGrantToken: "new", enforceLocationMatch: true });
    expect(denied.ok).toBe(false);
    expect(assertOpencodeToolScope({ requestedTools: ["write_node"], locationMcpGrantToken: "same", turnGrantToken: "same", enforceLocationMatch: true })).toEqual({ ok: true });
    expect(assertOpencodeToolScope({ requestedTools: ["write_node"], locationMcpGrantToken: null, turnGrantToken: null, enforceLocationMatch: true }).ok).toBe(false);
  });
});

describe("CodeBuddy ACP（任务 6.3/6.4）", () => {
  it("握手协议版本核对", () => {
    expect(parseCodeBuddyHandshake(200, "application/json", JSON.stringify({ acpVersion: "acp/1", tools: ["read"] }))).toMatchObject({ ok: true, tools: ["read"] });
    expect(parseCodeBuddyHandshake(200, "application/json", JSON.stringify({ acpVersion: "acp/2" }))).toMatchObject({ ok: false, code: "version-unsupported" });
    expect(parseCodeBuddyHandshake(404, "application/json", "{}")).toMatchObject({ ok: false, code: "runtime-missing" });
  });

  it("回合请求形状带 grant", () => {
    const req = acpTurnRequest("s1", "hi", "grant-1");
    expect(req.path).toBe("/acp/session/s1/turn");
    expect(req.body).toMatchObject({ prompt: "hi", grant: "grant-1" });
  });

  it("写工具授权轮换判定：默认允许写入，显式 rotationVerified: false 时 fail closed", () => {
    expect(assertCodeBuddyWriteScope({ requestedTools: [] })).toEqual({ ok: true });
    expect(assertCodeBuddyWriteScope({ requestedTools: ["write_node"] })).toEqual({ ok: true });
    expect(assertCodeBuddyWriteScope({ requestedTools: ["write_node"], rotationVerified: true })).toEqual({ ok: true });
    const denied = assertCodeBuddyWriteScope({ requestedTools: ["write_node"], rotationVerified: false });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("capability-unsupported");
  });

  it("事件解码：内容增量与工具终态", () => {
    const decoder = createAcpEventDecoder();
    decoder.onEvent({ event: "message", data: JSON.stringify({ type: "session.created", sessionId: "acp_1" }) });
    const delta = decoder.onEvent({ event: "message", data: JSON.stringify({ type: "content.delta", text: "ok" }) });
    expect(delta).toEqual([{ type: "message", role: "assistant", content: "ok", delivery: "append" }]);
    decoder.onEvent({ event: "message", data: JSON.stringify({ type: "tool.call", tool: "write_node", callId: "c1", status: "completed" }) });
    expect(decoder.finish()).toMatchObject({ status: "succeeded", assistantText: "ok", runId: "acp_1" });
  });

  it("request 辅助构造带 id 的 JSON-RPC 请求", () => {
    expect(request(7, "thread/start", { model: "gpt-5" })).toEqual({ jsonrpc: "2.0", id: 7, method: "thread/start", params: { model: "gpt-5" } });
  });
});
