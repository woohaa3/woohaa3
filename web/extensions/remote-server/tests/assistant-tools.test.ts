/**
 * 工具往返循环与 MCP 客户端。
 *
 * 这两块是导演区能用的关键：模型要求调工具时正文是空的，不回填结果它永远给不出答案；
 * 而工具拒绝的原因必须如实回到模型，否则它只会重复同一次错误调用。
 */
import { describe, expect, it } from "vitest";
import { createMcpToolClient } from "../src/backend/assistant/tool-client.js";
import { runToolLoop } from "../src/backend/assistant/tool-loop.js";
import type { RemoteChatMessage, RemoteToolCall } from "../src/backend/assistant/chat-client.js";

type TurnResult =
  | { ok: true; text: string; toolCalls: RemoteToolCall[]; finishReason: string }
  | { ok: false; code: string; message: string };

const call = (id: string, name: string, args: Record<string, unknown>): RemoteToolCall => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

/** 按脚本依次返回结果的 turn 替身。 */
function scriptedTurn(script: TurnResult[]) {
  const seen: Array<readonly RemoteChatMessage[]> = [];
  let index = 0;
  return {
    seen,
    turn: async ({ messages }: { messages: readonly RemoteChatMessage[] }) => {
      seen.push([...messages]);
      return script[index++]!;
    },
  };
}

describe("工具往返循环", () => {
  it("模型要求调工具时执行并回填，再取最终答案", async () => {
    const { turn, seen } = scriptedTurn([
      { ok: true, text: "", toolCalls: [call("c1", "get_world", {})], finishReason: "tool_calls" },
      { ok: true, text: "镜头已调整", toolCalls: [], finishReason: "stop" },
    ]);
    const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
    const result = await runToolLoop([{ role: "user", content: "调整镜头" }], {
      turn,
      execute: async (name, args) => {
        executed.push({ name, args });
        return { ok: true, content: '{"ok":true}' };
      },
    });
    expect(result).toMatchObject({ ok: true, text: "镜头已调整", rounds: 2 });
    expect(executed).toEqual([{ name: "get_world", args: {} }]);
    // 第二轮必须看到 assistant 的 tool_calls 与 tool 结果：缺任一项上游都无法配对。
    const second = seen[1]!;
    expect(second.some((message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) === 1)).toBe(true);
    const toolMessage = second.find((message) => message.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(toolMessage!.toolCallId).toBe("c1");
  });

  it("工具失败的原因回给模型，让它能自我修正", async () => {
    const { turn, seen } = scriptedTurn([
      { ok: true, text: "", toolCalls: [call("c1", "bad_tool", {})], finishReason: "tool_calls" },
      { ok: true, text: "改用另一种方式", toolCalls: [], finishReason: "stop" },
    ]);
    await runToolLoop([{ role: "user", content: "x" }], {
      turn,
      execute: async () => ({ ok: false, content: "[target-mismatch] 节点与本轮目标不一致" }),
    });
    const toolMessage = seen[1]!.find((message) => message.role === "tool");
    // 具体原因必须出现在回填内容里，否则模型只会重复同一个调用。
    expect(toolMessage!.content).toContain("target-mismatch");
  });

  // 锁定设计：**不设总轮数上限**，终点是模型自己不再要求调工具。
  // sdk-agent / local-agent 把循环交给 dsh / Codex / OpenCode，provider 层从不规定跑几步；
  // 远端模型没有 runtime，循环在这里，但语义必须一致。
  //
  // 现场故障：曾设 8 轮，一次「建宫殿」用了 9 轮（读上下文、读 API、建模型、5 段脚本、
  // 1 次 patch），被掐在第五段，用户看到"部分完成"。
  it("长任务每轮都在写入时能一直跑到模型自己收尾", async () => {
    const writing: TurnResult = {
      ok: true,
      text: "",
      toolCalls: [call("c1", "append_world_model_script", {})],
      finishReason: "tool_calls",
    };
    // 30 轮写入后收尾：远超任何"合理轮数"，循环仍应跑完。
    const script: TurnResult[] = [...Array(30).fill(writing), { ok: true, text: "宫殿建好了", toolCalls: [], finishReason: "stop" }];
    const { turn } = scriptedTurn(script);
    const result = await runToolLoop([{ role: "user", content: "x" }], {
      turn,
      execute: async () => ({ ok: true, content: '{"ok":true}' }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rounds).toBe(31);
  });

  it("连续无进展才熔断（链路坏了的判断，不是任务长度）", async () => {
    const failing: TurnResult = {
      ok: true,
      text: "",
      toolCalls: [call("c1", "bad_tool", {})],
      finishReason: "tool_calls",
    };
    const { turn } = scriptedTurn([failing, failing, failing, failing]);
    const result = await runToolLoop([{ role: "user", content: "x" }], {
      turn,
      execute: async () => ({ ok: false, content: "[rejected] 还是不行" }),
      maxIdleRounds: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("tool-loop-stalled");
  });

  it("中途有成功就把无进展计数清零，不提前熔断", async () => {
    const failing: TurnResult = {
      ok: true,
      text: "",
      toolCalls: [call("c1", "t", {})],
      finishReason: "tool_calls",
    };
    // 失败 2 次（idle=2）→ 第 3 次成功（idle 归零）→ 再失败 2 次（idle=2）→ 收尾。
    // 中途的成功证明链路是通的，不该按累计失败次数熔断。
    const { turn } = scriptedTurn([failing, failing, failing, failing, failing,
      { ok: true, text: "完成", toolCalls: [], finishReason: "stop" },
    ]);
    let calls = 0;
    const result = await runToolLoop([{ role: "user", content: "x" }], {
      turn,
      execute: async () => {
        calls += 1;
        return calls === 3 ? { ok: true, content: "{}" } : { ok: false, content: "[rejected]" };
      },
      maxIdleRounds: 3,
    });
    expect(result.ok).toBe(true);
  });

  it("工具参数不是合法 JSON 时回给模型而不是抛错", async () => {
    const broken: RemoteToolCall = { id: "c1", type: "function", function: { name: "t", arguments: "{半截" } };
    const { turn, seen } = scriptedTurn([
      { ok: true, text: "", toolCalls: [broken], finishReason: "tool_calls" },
      { ok: true, text: "好", toolCalls: [], finishReason: "stop" },
    ]);
    await runToolLoop([{ role: "user", content: "x" }], {
      turn,
      execute: async () => {
        throw new Error("不该被执行");
      },
    });
    const toolMessage = seen[1]!.find((message) => message.role === "tool");
    expect(toolMessage!.content).toContain("invalid-arguments");
  });

  it("模型直接回答时只跑一轮", async () => {
    const { turn } = scriptedTurn([{ ok: true, text: "直接答案", toolCalls: [], finishReason: "stop" }]);
    const result = await runToolLoop([{ role: "user", content: "x" }], { turn });
    expect(result).toMatchObject({ ok: true, text: "直接答案", rounds: 1 });
  });

  it("模型往返失败时保留已产出的正文", async () => {
    const { turn } = scriptedTurn([{ ok: false, code: "unavailable", message: "远端不可用" }]);
    const result = await runToolLoop([{ role: "user", content: "x" }], { turn });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unavailable");
  });
});

/** 一个可控的 MCP 端点替身。 */
function fakeMcp(replies: Record<string, unknown>) {
  const requests: Array<{ method: string; params?: unknown }> = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string; params?: unknown };
    requests.push({ method: body.method, params: body.params });
    const value = replies[body.method];
    const payload = typeof value === "function" ? (value as (params: unknown) => unknown)(body.params) : value;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...(payload as object) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

describe("MCP 工具客户端", () => {
  const endpoint = "http://127.0.0.1:5180/mcp/model-canvas";

  it("只列出本轮允许的工具", async () => {
    const mcp = fakeMcp({
      "tools/list": {
        result: {
          tools: [
            { name: "apply_canvas_plan", description: "写入", inputSchema: { type: "object" } },
            { name: "delete_everything", description: "不该出现", inputSchema: { type: "object" } },
          ],
        },
      },
    });
    const client = createMcpToolClient({ endpoint, grant: "g", allowedTools: ["apply_canvas_plan"], fetchImpl: mcp.fetchImpl });
    const tools = await client.listTools();
    // 多列出来的工具模型会去调，然后被拒——那是无谓的一轮来回。
    expect(tools.map((tool) => tool.name)).toEqual(["apply_canvas_plan"]);
  });

  it("拒绝未开放的工具并说明原因", async () => {
    const mcp = fakeMcp({});
    const client = createMcpToolClient({ endpoint, grant: "g", allowedTools: ["a"], fetchImpl: mcp.fetchImpl });
    const outcome = await client.callTool("b", {});
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain("tool-not-allowed");
    // 不该发请求：越界调用在本地就拦掉。
    expect(mcp.requests).toHaveLength(0);
  });

  it("结构化失败回执的 code 与 message 都会回给模型", async () => {
    const mcp = fakeMcp({
      "tools/call": {
        result: { isError: true, structuredContent: { ok: false, code: "lease-conflict", message: "目标被他人占用" } },
      },
    });
    const client = createMcpToolClient({ endpoint, grant: "g", allowedTools: ["a"], fetchImpl: mcp.fetchImpl });
    const outcome = await client.callTool("a", {});
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain("lease-conflict");
    expect(outcome.content).toContain("目标被他人占用");
  });

  it("JSON-RPC 错误不被当成成功", async () => {
    const mcp = fakeMcp({ "tools/call": { error: { code: -32602, message: "参数非法" } } });
    const client = createMcpToolClient({ endpoint, grant: "g", allowedTools: ["a"], fetchImpl: mcp.fetchImpl });
    const outcome = await client.callTool("a", {});
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain("参数非法");
  });

  it("成功结果带回可解析的正文", async () => {
    const mcp = fakeMcp({
      "tools/call": { result: { structuredContent: { ok: true, canvasId: "c1", commandId: "cmd-1" } } },
    });
    const client = createMcpToolClient({ endpoint, grant: "g", allowedTools: ["a"], fetchImpl: mcp.fetchImpl });
    const outcome = await client.callTool("a", {});
    expect(outcome.ok).toBe(true);
    expect(JSON.parse(outcome.content)).toMatchObject({ commandId: "cmd-1" });
  });

  it("release 后不再发请求", async () => {
    const mcp = fakeMcp({ "tools/list": { result: { tools: [] } } });
    const client = createMcpToolClient({ endpoint, grant: "g", allowedTools: [], fetchImpl: mcp.fetchImpl });
    client.dispose();
    await expect(client.listTools()).rejects.toThrow("已释放");
  });
});
