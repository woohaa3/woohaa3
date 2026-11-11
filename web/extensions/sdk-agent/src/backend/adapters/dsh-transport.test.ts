/**
 * DeepSeek Harness 传输的纯函数回归（不启动 runtime）。
 *
 * 真实 runtime 的端到端覆盖在 `fixed-engine-runtime.test.ts`；这里只钉住
 * 补丁生成（隔离面）与事件投影（工具名去掉 MCP 前缀、去重、不读推理）两处易回归点。
 */
import { describe, expect, it, vi } from "vitest";
import { buildDshPatch, DSH_DEFAULT_CONTEXT_WINDOW, DSH_DEFAULT_MAX_OUTPUT_TOKENS, DSH_DISABLED_PLUGINS, projectDshEvents, readDshContextWindow, readDshMaxOutputTokens, shouldContinueAfterReadOnlyTurn } from "./dsh-transport.js";

describe("dsh profile 补丁", () => {
  it("模型只走给定 baseURL 与短期凭据变量，不启用官方账号插件", () => {
    const patch = buildDshPatch({
      modelBaseUrl: "http://127.0.0.1:1234/v1",
      model: "controlled-model",
      apiKeyEnv: "WOOHAA_MODEL_API_KEY",
      mcp: null
    });
    // 复用 base 已挂载的适配器；再插一个实例会让 route 注册冲突。
    expect(patch).toContain("- id: llm-pi-ai");
    expect(patch).not.toContain("- insert:\n    - id: llm-pi-ai");
    expect(patch).toContain('api: openai-completions');
    expect(patch).toContain('baseURL: "http://127.0.0.1:1234/v1"');
    expect(patch).toContain('apiKeyEnv: "WOOHAA_MODEL_API_KEY"');
    expect(patch).toContain('"controlled-model"');
    expect(patch).toContain("          supportsReasoningEffort: true");
    // 默认回合不写固定 off，也不声明档位表：交给上游默认语义。
    expect(patch).not.toContain("        reasoning: off");
    expect(patch).not.toContain("            reasoningEfforts:");
    expect(patch).not.toContain("reasoningEfforts: false");
    // 真实 API Key 不进入配置文件（只写变量名）。
    expect(patch).not.toMatch(/(?:sk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9]{20,})/);
  });

  it("显式档位写入 wire 映射，未知档位不伪造", () => {
    const patch = buildDshPatch({ modelBaseUrl: "http://127.0.0.1:1/v1", model: "m", apiKeyEnv: "K", reasoningEffort: "high", mcp: null });
    expect(patch).toContain("        reasoning: high");
    expect(patch).toContain("            reasoningEfforts:");
    expect(patch).toContain('              high: "high"');
    expect(patch).toContain('              off: "none"');
    expect(buildDshPatch({ modelBaseUrl: "http://127.0.0.1:1/v1", model: "m", apiKeyEnv: "K", reasoningEffort: "ultra", mcp: null })).not.toContain("            reasoningEfforts:");
  });

  it("显式声明输出预算，并允许按部署调整", () => {
    const patch = buildDshPatch({ modelBaseUrl: "http://127.0.0.1:1/v1", model: "m", apiKeyEnv: "K", mcp: null });
    // dsh 缺省 32768；导演区一次性长脚本会写满额度并被静默截断。
    expect(patch).toContain(`            maxTokens: ${DSH_DEFAULT_MAX_OUTPUT_TOKENS}`);
    expect(DSH_DEFAULT_MAX_OUTPUT_TOKENS).toBeGreaterThan(32768);
    const custom = buildDshPatch({ modelBaseUrl: "http://127.0.0.1:1/v1", model: "m", apiKeyEnv: "K", maxTokens: 12000, mcp: null });
    expect(custom).toContain("            maxTokens: 12000");
  });

  it("只有正安全整数才覆盖输出预算", () => {
    const read = (value?: string) => readDshMaxOutputTokens((value === undefined ? {} : { WOOHAA3_SDK_AGENT_MAX_OUTPUT_TOKENS: value }) as NodeJS.ProcessEnv);
    expect(read()).toBe(DSH_DEFAULT_MAX_OUTPUT_TOKENS);
    expect(read("48000")).toBe(48000);
    for (const invalid of ["", "0", "-1", "many", "1.5"]) expect(read(invalid)).toBe(DSH_DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it("上下文窗口按模型真实容量声明，并满足压缩预留公式", () => {
    const patch = buildDshPatch({ modelBaseUrl: "http://127.0.0.1:1/v1", model: "m", apiKeyEnv: "K", mcp: null });
    expect(patch).toContain(`            contextWindow: ${DSH_DEFAULT_CONTEXT_WINDOW}`);
    // 256K 窗口是当前接入模型的真实容量；声明成 128K 会把压缩预留算成负数。
    expect(DSH_DEFAULT_CONTEXT_WINDOW).toBe(262144);
    expect(DSH_DEFAULT_CONTEXT_WINDOW - DSH_DEFAULT_MAX_OUTPUT_TOKENS - 65536).toBeGreaterThan(0);
    const custom = buildDshPatch({ modelBaseUrl: "http://127.0.0.1:1/v1", model: "m", apiKeyEnv: "K", contextWindow: 128000, mcp: null });
    expect(custom).toContain("            contextWindow: 128000");
    const read = (value?: string) => readDshContextWindow((value === undefined ? {} : { WOOHAA3_SDK_AGENT_CONTEXT_WINDOW: value }) as NodeJS.ProcessEnv);
    expect(read()).toBe(DSH_DEFAULT_CONTEXT_WINDOW);
    expect(read("131072")).toBe(131072);
    for (const invalid of ["", "0", "-5", "lots"]) expect(read(invalid)).toBe(DSH_DEFAULT_CONTEXT_WINDOW);
  });

  it("关闭全部内建工具与 plan-mode，讨论回合不挂 MCP", () => {
    const patch = buildDshPatch({
      modelBaseUrl: "http://127.0.0.1:1/v1",
      model: "m",
      apiKeyEnv: "K",
      mcp: null
    });
    for (const id of DSH_DISABLED_PLUGINS) expect(patch).toContain(`- id: ${id}\n  disabled: true`);
    // shell/文件/搜索/子代理/命令面都必须在禁用清单里。
    for (const id of ["tool-bash", "tool-fs", "tool-web", "tool-subagent", "commands", "plan-mode"]) {
      expect(DSH_DISABLED_PLUGINS).toContain(id);
    }
    expect(patch).not.toContain("dsh-mcp-client");
  });

  it("工具回合只插入受控 MCP 网关并带上本轮 grant", () => {
    const patch = buildDshPatch({
      modelBaseUrl: "http://127.0.0.1:1/v1",
      model: "m",
      apiKeyEnv: "K",
      mcp: { name: "woohaa", url: "http://127.0.0.1:9999/mcp", bearerToken: "grant-1" }
    });
    expect(patch).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(patch).toContain('serverName: "woohaa"');
    expect(patch).toContain('"http://127.0.0.1:9999/mcp"');
    expect(patch).toContain('Authorization: "Bearer grant-1"');
    expect(patch).toContain("failOnStartupError: true");
  });
});

describe("dsh 事件投影", () => {
  type Event = { type: string; data?: Record<string, unknown> };
  const assistant = (text: string, blocks: unknown[] = []): Event => ({
    type: "assistant/message",
    data: { message: { content: [{ type: "text", text }, ...blocks] } }
  });
  const toolCall = (callId: string, name: string, args = "{}"): Event => ({
    type: "tool/call",
    data: { callId, name, arguments: args }
  });

  it("拼接可见文本并去掉 MCP 前缀，同一 callId 只投影一次", () => {
    const emitted: unknown[] = [];
    const result = projectDshEvents(
      [
        assistant("first ", [{ type: "tool-call", id: "call_1", name: "mcp__woohaa__submit_model_script", arguments: "{}" }]),
        toolCall("call_1", "mcp__woohaa__submit_model_script"),
        assistant("second")
      ],
      "woohaa",
      (event) => emitted.push(event)
    );
    expect(result.assistantText).toBe("first second");
    expect(result.toolCalls).toEqual([{ id: "call_1", name: "submit_model_script", argumentsJson: "{}" }]);
    // 文本与工具各一次，重复的 tool/call 不重复投影。
    expect(emitted.filter((event) => (event as { type: string }).type === "tool-call")).toHaveLength(1);
  });

  it("记录每条助手消息的块类型与模型级终止原因", () => {
    const projected = projectDshEvents([
      {
        type: "assistant/message",
        data: {
          message: { content: [{ type: "text", text: "ok" }, { type: "tool-call", id: "c1", name: "mcp__woohaa__create_world_model", arguments: "{}" }] },
          stream: [{ time: 1, chunk: { type: "text-delta", text: "ok" } }, { time: 2, chunk: { type: "finish", reason: { kind: "max-tokens" } } }]
        }
      }
    ] as Event[], "woohaa", () => undefined);
    expect(projected.assistantMessages).toEqual([{ blocks: ["text", "tool-call:mcp__woohaa__create_world_model"], finish: "max-tokens" }]);
  });

  it("透出 turn/end 的结束原因（输出额度写满不是错误）", () => {
    const projected = projectDshEvents(
      [
        assistant("我先读一下"),
        { type: "turn/end", data: { turn: 1, reason: { kind: "max-tokens" } } }
      ] as Event[],
      "woohaa",
      () => undefined
    );
    expect(projected.turnEnd).toBe("max-tokens");
  });

  it("没有 turn/end 事件时不伪造结束原因", () => {
    expect(projectDshEvents([assistant("done")], "woohaa", () => undefined).turnEnd).toBeUndefined();
    expect(projectDshEvents([{ type: "turn/end", data: { reason: { kind: "blocked" } } }] as Event[], "woohaa", () => undefined).turnEnd).toBe("blocked");
  });

  it("非本网关的工具名保持原样（不伪造命名空间）", () => {
    const result = projectDshEvents(
      [toolCall("call_9", "mcp__other__do_thing")],
      "woohaa",
      () => undefined
    );
    expect(result.toolCalls).toEqual([{ id: "call_9", name: "mcp__other__do_thing", argumentsJson: "{}" }]);
  });

  it("忽略推理与其他事件类型", () => {
    const emit = vi.fn();
    const result = projectDshEvents(
      [
        { type: "assistant/attempt", data: { stream: [{ type: "reasoning-chunks", texts: ["secret"] }] } },
        { type: "system/message", data: { message: { content: [{ type: "text", text: "prompt" }] } } }
      ] as Event[],
      null,
      emit
    );
    expect(result).toEqual({ assistantText: "", toolCalls: [], assistantMessages: [] });
    expect(emit).not.toHaveBeenCalled();
  });

  it("无 mcp 名称时不去前缀，参数按原始 JSON 透传", () => {
    const result = projectDshEvents(
      [toolCall("call_2", "submit_model_script", '{"size":2}')],
      null,
      () => undefined
    );
    expect(result.toolCalls).toEqual([{ id: "call_2", name: "submit_model_script", argumentsJson: '{"size":2}' }]);
  });

  it("只读工具正常结束时允许同一 Harness 会话续回合", () => {
    expect(shouldContinueAfterReadOnlyTurn({
      assistantText: "我先读取上下文",
      toolCalls: [
        { id: "1", name: "get_world_context", argumentsJson: "{}" },
        { id: "2", name: "get_model_api", argumentsJson: "{}" }
      ],
      assistantMessages: [],
      turnEnd: "completed"
    })).toBe(true);
    expect(shouldContinueAfterReadOnlyTurn({
      assistantText: "已写入",
      toolCalls: [{ id: "1", name: "create_world_model", argumentsJson: "{}" }],
      assistantMessages: [],
      turnEnd: "completed"
    })).toBe(false);
    expect(shouldContinueAfterReadOnlyTurn({
      assistantText: "截断",
      toolCalls: [{ id: "1", name: "get_world_context", argumentsJson: "{}" }],
      assistantMessages: [],
      turnEnd: "max-tokens"
    })).toBe(false);
  });
});
