/**
 * 导演区工具回合的集成验证：真实循环 + 真实 MCP 线格式 + 真实凭证签发接缝。
 *
 * 为什么单测不够：单测把 turn 与 executor 都换成替身，验不出"消息是否按 OpenAI 形状
 * 序列化""tool_call_id 是否配对""grant 是否真的签发与撤销"。这里用一个真实的
 * HTTP MCP 服务（说 JSON-RPC）加真实的 adapter，只把模型与宿主授权替换成可控实现，
 * 其余走真实代码路径。
 *
 * 锁定的现场故障：导演区提交后报「助手返回了工具调用文本」，模型把调用写成了
 * `<｜DSML｜invoke>` 这样的文本——它根本没收到 `tools` 声明，因为那一轮被当成了讨论。
 */
import { preparedTurnHash, stripPreparedHash } from "@woohaa3/contracts";
import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentAdapterRunInput } from "@woohaa3/contracts";
import { createRemoteAssistant, REMOTE_ASSISTANT_CONNECTION_ID } from "../src/backend/assistant/index.js";
import { createCanvasToolChannel } from "../src/backend/assistant/canvas-tools.js";
import { REMOTE_ASSISTANT_ADAPTER_ID } from "../src/shared.js";

/** 一个说 JSON-RPC 的真实 MCP 服务（只实现本轮用到的三个方法）。 */
function startMcpServer(options: {
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  call: (name: string, args: Record<string, unknown>) => { ok: boolean; structured?: Record<string, unknown> };
}): Promise<{ server: Server; endpoint: string; calls: Array<{ name: string; args: Record<string, unknown> }> }> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id: number;
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    const send = (payload: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...(payload as object) }));
    };
    if (body.method === "tools/list") {
      send({ result: { tools: options.tools } });
      return;
    }
    if (body.method === "tools/call") {
      const name = body.params?.name ?? "";
      const args = body.params?.arguments ?? {};
      calls.push({ name, args });
      const outcome = options.call(name, args);
      send({
        result: {
          ...(outcome.ok ? {} : { isError: true }),
          content: [{ type: "text", text: outcome.ok ? "ok" : "failed" }],
          ...(outcome.structured ? { structuredContent: outcome.structured } : {}),
        },
      });
      return;
    }
    send({ result: {} });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, endpoint: `http://127.0.0.1:${port}/mcp/model-canvas`, calls });
    });
  });
}

/** 一个按脚本返回的模型端点（说 OpenAI chat completions）。 */
function startChatServer(script: Array<Record<string, unknown>>) {
  const requests: Array<{ messages: Array<Record<string, unknown>>; tools?: unknown[] }> = [];
  let index = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      messages: Array<Record<string, unknown>>;
      tools?: unknown[];
    };
    requests.push({ messages: body.messages, tools: body.tools });
    const next = script[index++] ?? { choices: [{ message: { content: "结束" }, finish_reason: "stop" }] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(next));
  });
  return new Promise<{ server: Server; baseUrl: string; requests: typeof requests }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, requests });
    });
  });
}

/** 一次导演区（world）目标回合的输入。 */
function worldTurn(overrides: Partial<AgentAdapterRunInput> = {}): AgentAdapterRunInput {
  return {
    owner: "local:test",
    canvasId: "canvas-1",
    conversationId: "conv-1",
    turnId: "turn-1",
    requestId: "req-1",
    intent: {
      // 关键：导演区提交的是 generate，不是 discuss。
      action: "generate",
      canvasId: "canvas-1",
      nodeId: "scene-area-1",
      mode: "world",
      model: "m",
      prompt: "构建一个宫殿的场景",
    },
    connection: {
      connectionId: REMOTE_ASSISTANT_CONNECTION_ID,
      adapterId: REMOTE_ASSISTANT_ADAPTER_ID,
      configRevision: 1,
      credentialEpoch: 0,
    },
    history: [],
    signal: new AbortController().signal,
    emit: () => undefined,
    prepared: {
      schemaVersion: 1,
      roleRef: { namespacedId: "remote-server/world", roleId: "world", extensionId: "remote-server", revision: "1", descriptorDigest: "d", artifactId: "a" },
      messages: [{ role: "system", content: "你是世界场景作者。" }, { role: "user", content: "构建一个宫殿的场景" }],
      // 宿主求交后的工具集：非空才表示这一轮可以写。
      tools: ["get_world_context", "create_world_model"],
      nativeCapabilities: [],
      output: { kind: "tool-receipts" },
      inputDigest: "i",
      contextDigest: "c",
      attachmentDigests: [],
      target: { canvasId: "canvas-1", nodeId: "scene-area-1", mode: "world" },
      preparedHash: "h",
    } as never,
    ...overrides,
  } as AgentAdapterRunInput;
}

describe("导演区工具回合（真实 MCP 线格式）", () => {
  it("模型要求工具时真的执行、回填，并以权威回执结束", async () => {
    const mcp = await startMcpServer({
      tools: [
        { name: "get_world_context", description: "读世界" },
        { name: "create_world_model", description: "建模型" },
        // 未开放的工具：不该被列给模型。
        { name: "delete_everything", description: "不该出现" },
      ],
      call: (name) =>
        name === "create_world_model"
          ? { ok: true, structured: { ok: true, canvasId: "canvas-1", nodeId: "scene-area-1", commandId: "cmd-1", revision: 9 } }
          : { ok: true, structured: { ok: true, canvasId: "canvas-1" } },
    });
    const chat = await startChatServer([
      {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "create_world_model", arguments: '{"name":"宫殿","kind":"model"}' },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "宫殿已建好" } }] },
    ]);

    const issued: unknown[] = [];
    const revoked: string[] = [];
    const assistant = createRemoteAssistant({
      fetchImpl: fetch,
      session: async () => ({ serverUrl: chat.baseUrl, token: "t" }),
      toolChannel: (input) =>
        createCanvasToolChannel(input, {
          endpoint: mcp.endpoint,
          fetchImpl: fetch,
          tools: {
            issue: async (request: { workId: string }) => {
              issued.push(request);
              return { token: "grant-token", workId: request.workId } as never;
            },
            revoke: (workId: string) => {
              revoked.push(workId);
            },
            authorize: () => ({ ok: true }),
          } as never,
        }),
    });

    const outcome = await assistant.adapter.run(worldTurn());

    // 模型必须真的收到工具声明——这正是"写成文本调用"那次故障的根源。
    expect(chat.requests[0]!.tools).toBeDefined();
    expect((chat.requests[0]!.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name)).toEqual([
      "get_world_context",
      "create_world_model",
    ]);

    // 工具真的被执行了。
    expect(mcp.calls.map((call) => call.name)).toEqual(["create_world_model"]);

    // 回填的消息带 tool_call_id：缺了它上游无法配对，会把结果当没发生。
    const second = chat.requests[1]!.messages;
    const assistantMessage = second.find((message) => message.role === "assistant");
    expect(assistantMessage?.tool_calls).toBeDefined();
    const toolMessage = second.find((message) => message.role === "tool");
    expect(toolMessage?.tool_call_id).toBe("c1");

    // 有权威回执才算成功：模型说"建好了"不算。
    expect(outcome.status).toBe("succeeded");
    expect(outcome.receipt).toMatchObject({ kind: "canvas-commands", commands: [{ commandId: "cmd-1" }] });

    // grant 必须签发并撤销：漏撤销会让已结束的回合仍持有可写能力。
    expect(issued).toHaveLength(1);
    expect(revoked).toEqual(["req-1"]);

    mcp.server.close();
    chat.server.close();
  }, 60_000);

  it("模型没调工具只聊天时，如实报「没有提交修改」", async () => {
    const mcp = await startMcpServer({ tools: [{ name: "create_world_model" }], call: () => ({ ok: true }) });
    const chat = await startChatServer([
      { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "我可以帮你建，请确认。" } }] },
    ]);
    const assistant = createRemoteAssistant({
      fetchImpl: fetch,
      session: async () => ({ serverUrl: chat.baseUrl, token: "t" }),
      toolChannel: (input) =>
        createCanvasToolChannel(input, {
          endpoint: mcp.endpoint,
          fetchImpl: fetch,
          tools: { issue: async () => ({ token: "g" }) as never, revoke: () => undefined, authorize: () => ({ ok: true }) } as never,
        }),
    });
    const outcome = await assistant.adapter.run(worldTurn());
    // 不能把"聊了两句"当成改好了。
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("write-unconfirmed");
    mcp.server.close();
    chat.server.close();
  }, 60_000);

  it("工具失败时如实失败并保留可读原因", async () => {
    const mcp = await startMcpServer({
      tools: [{ name: "create_world_model" }],
      call: () => ({ ok: false, structured: { ok: false, code: "lease-conflict", message: "目标被占用" } }),
    });
    const chat = await startChatServer([
      {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "c1", type: "function", function: { name: "create_world_model", arguments: "{}" } }],
            },
          },
        ],
      },
      { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "无法完成" } }] },
    ]);
    const assistant = createRemoteAssistant({
      fetchImpl: fetch,
      session: async () => ({ serverUrl: chat.baseUrl, token: "t" }),
      toolChannel: (input) =>
        createCanvasToolChannel(input, {
          endpoint: mcp.endpoint,
          fetchImpl: fetch,
          tools: { issue: async () => ({ token: "g" }) as never, revoke: () => undefined, authorize: () => ({ ok: true }) } as never,
        }),
    });
    const outcome = await assistant.adapter.run(worldTurn());
    expect(outcome.status).toBe("failed");
    // 模型看到了失败原因，但确实没有写入 → 不该给出成功。
    expect(outcome.receipt).toBeUndefined();
    mcp.server.close();
    chat.server.close();
  }, 60_000);

  it("discuss 回合即使有工具集也不进写路径", async () => {
    const mcp = await startMcpServer({ tools: [{ name: "create_world_model" }], call: () => ({ ok: true }) });
    const chat = await startChatServer([
      { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "只是聊天" } }] },
    ]);
    let channelBuilt = 0;
    const assistant = createRemoteAssistant({
      fetchImpl: fetch,
      session: async () => ({ serverUrl: chat.baseUrl, token: "t" }),
      toolChannel: (input) => {
        channelBuilt += 1;
        return createCanvasToolChannel(input, {
          endpoint: mcp.endpoint,
          fetchImpl: fetch,
          tools: { issue: async () => ({ token: "g" }) as never, revoke: () => undefined, authorize: () => ({ ok: true }) } as never,
        });
      },
    });
    const discuss = worldTurn();
    (discuss.intent as { action: string; mode?: string }).action = "discuss";
    const outcome = await assistant.adapter.run(discuss);
    expect(outcome.status).toBe("succeeded");
    // 讨论不该签发 grant。
    expect(channelBuilt).toBe(0);
    mcp.server.close();
    chat.server.close();
  }, 60_000);
});


it("remote API discussion has no local filesystem capability or MCP channel", async () => {
  const chat = await startChatServer([{ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "回复" } }] }]);
  const toolChannel = () => { throw new Error("Discussion must not open MCP"); };
  try {
    const assistant = createRemoteAssistant({ fetchImpl: fetch, session: async () => ({ serverUrl: chat.baseUrl, token: "model-token" }), toolChannel });
    const input = worldTurn({ intent: { action: "discuss", canvasId: "canvas-1", prompt: "讨论", model: "m" } });
    expect(await assistant.adapter.run(input)).toMatchObject({ status: "succeeded" });
    expect(chat.requests[0]!.tools ?? []).toEqual([]);
    expect(assistant.adapter.capabilities().workspace).not.toBe(true);
  } finally { await new Promise<void>(resolve => { chat.server.close(() => resolve()); chat.server.closeAllConnections(); }); }
});
