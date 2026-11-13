/**
 * Agent SDK 适配器限制与事件映射测试（本地模拟；不启动真实子进程）
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 7.1/7.2/7.3 验收）。
 *
 * 覆盖：执行前限制（内建 shell/文件写不可达、只读工作目录、不加载用户设置）、
 * 显式 API Key 注入与实例隔离（不读全局 env）、讨论回合无 MCP、缺 Key/缺运行时准确报错。
 */
import { describe, expect, it, vi } from "vitest";
import type { ApplicationToolDelegationFacade } from "@woohaa3/contracts";
import { buildAgentSdkRestrictions, CLAUDE_BUILTIN_TOOLS, CODEX_BUILTIN_TOOLS, createAgentSdkAdapter, MCP_RESOURCE_TOOL_NAMES, type AgentSdkTransport } from "./agent-sdk-adapter.js";

const tools: ApplicationToolDelegationFacade = {
  issue: async () => ({ token: "t", canvasIds: [], nodeIds: [], tools: [], workId: "w" }),
  revoke: () => undefined,
  authorize: ({ tool }) => (tool === "write_node" ? { ok: true } : { ok: false, reason: "越权" })
};

function transport(overrides?: { run?: AgentSdkTransport["run"] }): { transport: AgentSdkTransport; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    transport: {
      run: async (input) => {
        calls.push(input as unknown as Record<string, unknown>);
        if (overrides?.run) return overrides.run(input);
        input.onEvent({ type: "text-delta", text: "完成" });
        input.onNativeId("native-1");
        return { ok: true, assistantText: "完成", toolCalls: [], finishReason: "stop", nativeId: "native-1" };
      }
    }
  };
}

const okRuntime = async () => ({ ok: true as const });

describe("Agent SDK 执行前限制（任务 7.3）", () => {
  it.each(["codex-agent-sdk", "claude-agent-sdk", "dsh-agent-sdk", "gemini-agent-adk"] as const)("%s keeps long generation and large output alive until completion or user stop", async kind => {
    vi.useFakeTimers();
    try {
      const text = "正文".repeat(300_000);
      const { transport: t } = transport({ run: async input => {
        if (input.signal.aborted) return { ok: false, code: "cancelled", message: "stopped" };
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        expect(input.signal.aborted).toBe(false);
        input.onEvent({ type: "text-delta", text });
        expect(input.signal.aborted).toBe(false);
        return { ok: true, assistantText: text, toolCalls: [], finishReason: "stop" };
      } });
      const adapter = createAgentSdkAdapter({ kind, apiKey: "test", configDir: "/tmp/c", workspaceDir: "/tmp/ws", transport: t, probeRuntime: okRuntime });
      expect(await adapter.run({ model: "m", prompt: "p", tools: [], signal: new AbortController().signal })).toMatchObject({ ok: true, outcome: { assistantText: text } });
      const controller = new AbortController();
      controller.abort();
      const cancelled = await adapter.run({ model: "m", prompt: "p", tools: [], signal: controller.signal });
      expect(cancelled).toMatchObject({ ok: false, code: "cancelled" });
    } finally { vi.useRealTimers(); }
  });

  it("不再有可注入的时长预算：长回合只在取消或引擎结束时停止", async () => {
    vi.useFakeTimers();
    try {
      const { transport: t } = transport({ run: async input => {
        await vi.advanceTimersByTimeAsync(3_600_000);
        expect(input.signal.aborted).toBe(false);
        return { ok: true, assistantText: "long", toolCalls: [], finishReason: "stop" };
      } });
      const adapter = createAgentSdkAdapter({ kind: "codex-agent-sdk", apiKey: "test", configDir: "/tmp/c", workspaceDir: "/tmp/ws", transport: t, probeRuntime: okRuntime });
      expect(await adapter.run({ model: "m", prompt: "p", tools: [], signal: new AbortController().signal })).toMatchObject({ ok: true, outcome: { assistantText: "long" } });
    } finally { vi.useRealTimers(); }
  });

  it("Codex 限制：只读沙箱、禁用内建 shell、黑名单内建工具", () => {
    const restrictions = buildAgentSdkRestrictions({ kind: "codex-agent-sdk", workspaceDir: "/tmp/ws", allowedTools: ["write_node"] });
    expect(restrictions.sandboxMode).toBe("read-only");
    expect(restrictions.approvalPolicy).toBe("never");
    expect(restrictions.webSearchMode).toBe("disabled");
    expect(restrictions.disallowedTools).toContain("shell");
    expect(restrictions.disallowedTools).toEqual([...CODEX_BUILTIN_TOOLS]);
    expect(restrictions.allowedTools).toEqual(["write_node"]);
    expect(restrictions.settingSources).toEqual([]);
    expect(restrictions.credentialEnvVar).toBe("OPENAI_API_KEY");
  });

  it("Claude 限制：关闭内建 Bash/Write/Edit 等工具", () => {
    const restrictions = buildAgentSdkRestrictions({ kind: "claude-agent-sdk", workspaceDir: "/tmp/ws", allowedTools: ["read_node"] });
    for (const tool of ["Bash", "Write", "Edit"]) expect(restrictions.disallowedTools).toContain(tool);
    expect(restrictions.disallowedTools).toEqual([...CLAUDE_BUILTIN_TOOLS]);
    expect(restrictions.credentialEnvVar).toBe("ANTHROPIC_API_KEY");
  });

  it("讨论回合（无工具 token）不注入 MCP，allowedTools 为空", async () => {
    const { transport: t, calls } = transport();
    const adapter = createAgentSdkAdapter({ kind: "claude-agent-sdk", apiKey: "sk-ant", configDir: "/tmp/c", workspaceDir: "/tmp/ws", transport: t, probeRuntime: okRuntime });
    const result = await adapter.run({
      model: "claude-sonnet-4-5",
      prompt: "聊聊",
      tools: [{ name: "write_node", description: "w", parameters: {} }],
      signal: new AbortController().signal,
      mcpEndpoint: { name: "woohaa", url: "http://127.0.0.1:5180/mcp/model-canvas" }
    });
    expect(result.ok).toBe(true);
    expect(calls[0].mcp).toBeNull();
    expect((calls[0].restrictions as { allowedTools: string[] }).allowedTools).toEqual([]);
  });

  it("有工具 token 时注入 MCP 且只允许本轮工具", async () => {
    const { transport: t, calls } = transport();
    const adapter = createAgentSdkAdapter({ kind: "codex-agent-sdk", apiKey: "sk-x", configDir: "/tmp/c", workspaceDir: "/tmp/ws", transport: t, probeRuntime: okRuntime });
    const result = await adapter.run({
      model: "gpt-5-codex",
      prompt: "改节点",
      tools: [{ name: "write_node", description: "w", parameters: {} }],
      toolToken: "grant-1",
      toolFacade: tools,
      signal: new AbortController().signal,
      mcpEndpoint: { name: "woohaa", url: "http://127.0.0.1:5180/mcp/model-canvas" }
    });
    expect(result.ok).toBe(true);
    expect(calls[0].mcp).toMatchObject({ name: "woohaa", bearerToken: "grant-1" });
    expect((calls[0].restrictions as { allowedTools: string[] }).allowedTools).toEqual(["write_node"]);
  });

  it("缺 Key 返回 credential-missing；缺运行时返回 runtime-missing（不假装可用）", async () => {
    const { transport: t } = transport();
    const noKey = createAgentSdkAdapter({ kind: "claude-agent-sdk", apiKey: "", configDir: "/tmp/c", workspaceDir: "/tmp/ws", transport: t });
    const noKeyResult = await noKey.run({ model: "m", prompt: "p", tools: [], signal: new AbortController().signal });
    expect(noKeyResult).toEqual({ ok: false, code: "credential-missing", message: "该连接尚未保存 API Key" });

    const probe = vi.fn(async () => ({ ok: false as const, code: "runtime-missing" as const, message: "缺 CLI" }));
    const noRuntime = createAgentSdkAdapter({ kind: "codex-agent-sdk", apiKey: "sk-x", configDir: "/tmp/c", workspaceDir: "/tmp/ws", transport: t, probeRuntime: probe });
    const noRuntimeResult = await noRuntime.run({ model: "m", prompt: "p", tools: [], signal: new AbortController().signal });
    expect(noRuntimeResult.ok).toBe(false);
    if (!noRuntimeResult.ok) expect(noRuntimeResult.code).toBe("runtime-missing");
  });

  it("越权工具调用不执行，映射为工具结果错误", async () => {
    const seen: Array<{ isError?: boolean }> = [];
    const { transport: t } = transport({
      run: async (input) => {
        input.onEvent({ type: "tool-call", call: { id: "c1", name: "delete_everything", argumentsJson: "{}" } });
        return { ok: true, assistantText: "", toolCalls: [], finishReason: "tool_calls" };
      }
    });
    const adapter = createAgentSdkAdapter({ kind: "codex-agent-sdk", apiKey: "sk-x", configDir: "/tmp/c", workspaceDir: "/tmp/ws", transport: t, probeRuntime: okRuntime });
    const result = await adapter.run({
      model: "m",
      prompt: "p",
      tools: [{ name: "write_node", description: "w", parameters: {} }],
      toolToken: "grant-1",
      toolFacade: tools,
      signal: new AbortController().signal,
      onToolResult: (_call, outcome) => seen.push(outcome)
    });
    expect(result).toMatchObject({ ok: false, code: "capability-unsupported" });
    expect(seen[0]?.isError).toBe(true);
  });

  it("运行时自带的 MCP 资源读取工具不算越权，也不中止回合", async () => {
    const seen: string[] = [];
    const { transport: t } = transport({
      run: async (input) => {
        input.onEvent({ type: "tool-call", call: { id: "c1", name: "read_mcp_resource", argumentsJson: "{}" } });
        return { ok: true, assistantText: "", toolCalls: [{ id: "c1", name: "read_mcp_resource", argumentsJson: "{}" }], finishReason: "tool_calls" };
      }
    });
    const adapter = createAgentSdkAdapter({ kind: "dsh-agent-sdk", apiKey: "sk-x", configDir: "/tmp/c", workspaceDir: "/tmp/ws", transport: t, probeRuntime: okRuntime });
    const result = await adapter.run({
      model: "m",
      prompt: "p",
      tools: [{ name: "create_world_model", description: "c", parameters: {} }],
      toolToken: "grant-1",
      toolFacade: tools,
      signal: new AbortController().signal,
      onToolCall: (call) => seen.push(call.name)
    });
    expect(MCP_RESOURCE_TOOL_NAMES).toContain("read_mcp_resource");
    expect(result).toMatchObject({ ok: true });
    expect(seen).toEqual(["read_mcp_resource"]);
  });

  it("MCP 客户端返回带 server 前缀的工具名时仍按本轮原名授权", async () => {
    const seen: string[] = [];
    const { transport: t } = transport({
      run: async (input) => {
        input.onEvent({ type: "tool-call", call: { id: "c1", name: "mcp__woohaa__create_world_model", argumentsJson: "{}" } });
        return { ok: true, assistantText: "", toolCalls: [{ id: "c1", name: "mcp__woohaa__create_world_model", argumentsJson: "{}" }], finishReason: "tool_calls" };
      }
    });
    const adapter = createAgentSdkAdapter({ kind: "dsh-agent-sdk", apiKey: "sk-x", configDir: "/tmp/c", workspaceDir: "/tmp/ws", transport: t, probeRuntime: okRuntime });
    const result = await adapter.run({
      model: "m",
      prompt: "p",
      tools: [{ name: "create_world_model", description: "c", parameters: {} }],
      toolToken: "grant-1",
      toolFacade: tools,
      signal: new AbortController().signal,
      onToolCall: (call) => seen.push(call.name)
    });
    expect(result).toMatchObject({ ok: true, outcome: { toolCalls: [{ name: "create_world_model" }] } });
    expect(seen).toEqual(["create_world_model"]);
  });
});
