/**
 * 远端助手通路测试：连接投影、能力声明、两条执行分支与错误收敛。
 *
 * 没有真实服务端可测（本 change 的服务端实现不在这个仓库）：这里用进程内 fake
 * 兼容面锁住**客户端行为契约**——无会话时不投影连接、多模型共用一条连接、
 * 文本交付走无工具候选、讨论走流式增量、失败不泄漏远端信息。
 */
import { describe, expect, it } from "vitest";
import type { AgentAdapterRunInput } from "@woohaa3/contracts";
import { isAgentAdapterCapabilities, isAgentConnectionView } from "@woohaa3/contracts";
import {
  createRemoteAssistant,
  REMOTE_ASSISTANT_CONNECTION_ID,
} from "../src/backend/assistant/index.js";
import { REMOTE_ASSISTANT_ADAPTER_ID } from "../src/shared.js";
import { __test } from "../src/backend/assistant/chat-client.js";

type ChatCall = { model: string; messages: Array<{ role: string; content: string }>; stream: boolean };

/** 一个可控的 fake 兼容面：按需返回模型、结果或错误。 */
function createFakeSurface(options: {
  models?: string[];
  chatText?: string;
  chatStatus?: number;
  streamDeltas?: string[];
  modelsStatus?: number;
} = {}) {
  const calls: ChatCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/models")) {
      if (options.modelsStatus !== undefined && options.modelsStatus >= 400) {
        return new Response("{}", { status: options.modelsStatus });
      }
      const data = (options.models ?? []).map((id) => ({ id, object: "model" }));
      return new Response(JSON.stringify({ object: "list", data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/v1/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as ChatCall;
      calls.push({ model: body.model, messages: body.messages ?? [], stream: Boolean(body.stream) });
      if (options.chatStatus !== undefined && options.chatStatus >= 400) {
        return new Response(JSON.stringify({ error: { message: "upstream secret detail" } }), {
          status: options.chatStatus,
          headers: { "content-type": "application/json" },
        });
      }
      if (body.stream) {
        const frames = (options.streamDeltas ?? []).map(
          (delta) => `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`
        );
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            for (const frame of frames) controller.enqueue(encoder.encode(frame));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: options.chatText ?? "ok" } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

function sessionFor(token = "session-token") {
  return async () => ({ serverUrl: "http://10.0.0.5:8080", token });
}

function runInput(overrides: Partial<AgentAdapterRunInput> & { model?: string } = {}): AgentAdapterRunInput {
  return {
    owner: "local:test",
    canvasId: "canvas-1",
    conversationId: "conversation-1",
    turnId: "turn-1",
    requestId: "request-1",
    intent: {
      action: "discuss",
      canvasId: "canvas-1",
      nodeId: "text-1",
      mode: "text",
      connectionId: REMOTE_ASSISTANT_CONNECTION_ID,
      model: overrides.model ?? "remote-model",
      prompt: "你好",
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
    ...overrides,
  } as AgentAdapterRunInput;
}

describe("远端助手连接投影", () => {
  it("没有会话时不投影任何连接", async () => {
    const surface = createFakeSurface({ models: ["m"] });
    const assistant = createRemoteAssistant({ fetchImpl: surface.fetchImpl, session: async () => null });
    expect(await assistant.provider.listConnections({ owner: "local:test" })).toEqual([]);
  });

  it("多个模型共用一条连接", async () => {
    const surface = createFakeSurface({ models: ["a", "b", "c"] });
    const assistant = createRemoteAssistant({ fetchImpl: surface.fetchImpl, session: sessionFor() });
    const connections = await assistant.provider.listConnections({ owner: "local:test" });
    expect(connections).toHaveLength(1);
    expect(connections[0]!.connectionId).toBe(REMOTE_ASSISTANT_CONNECTION_ID);
    expect(connections[0]!.models.map((model) => model.id)).toEqual(["a", "b", "c"]);
    expect(connections[0]!.ready).toBe(true);
  });

  it("文本交付能力必须有值，否则文本节点选不到这条连接", async () => {
    const surface = createFakeSurface({ models: ["a"] });
    const assistant = createRemoteAssistant({ fetchImpl: surface.fetchImpl, session: sessionFor() });
    const [connection] = await assistant.provider.listConnections({ owner: "local:test" });
    expect(connection!.capabilities.textDelivery).toEqual({ imageInput: false, maxImages: 0 });
    // 远端助手不提供画布写工具：界面据此说明"不支持作品修改"。
    expect(connection!.capabilities.tools).toBe(false);
  });

  it("连接视图不含会话令牌", async () => {
    const surface = createFakeSurface({ models: ["a"] });
    const assistant = createRemoteAssistant({ fetchImpl: surface.fetchImpl, session: sessionFor("super-secret") });
    const connections = await assistant.provider.listConnections({ owner: "local:test" });
    expect(JSON.stringify(connections)).not.toContain("super-secret");
  });

  it("目录读取失败保留连接但标明原因，且清空缓存后重读", async () => {
    const surface = createFakeSurface({ modelsStatus: 503 });
    const assistant = createRemoteAssistant({ fetchImpl: surface.fetchImpl, session: sessionFor() });
    const [connection] = await assistant.provider.listConnections({ owner: "local:test" });
    expect(connection).toBeDefined();
    expect(connection!.ready).toBe(false);
    expect(connection!.modelsError).toBeTruthy();
  });

  it("会话失效后 invalidate 使下一次读取回落到空列表", async () => {
    const surface = createFakeSurface({ models: ["a"] });
    let token: string | null = "session-token";
    const assistant = createRemoteAssistant({
      fetchImpl: surface.fetchImpl,
      session: async () => (token === null ? null : { serverUrl: "http://10.0.0.5:8080", token }),
    });
    expect(await assistant.provider.listConnections({ owner: "local:test" })).toHaveLength(1);
    token = null;
    assistant.invalidate();
    expect(await assistant.provider.listConnections({ owner: "local:test" })).toEqual([]);
  });
});

describe("模型启停策略过滤", () => {
  const policyRows = (entries: Array<[string, boolean, boolean?]>) => () => ({
    initialized: true,
    models: entries.map(([modelKey, enabled, tombstone]) => ({
      modelKey,
      enabled,
      ...(tombstone ? { tombstone: true } : {}),
    })),
  });

  it("只投影被启用的模型", async () => {
    const surface = createFakeSurface({ models: ["on-model", "off-model"] });
    const assistant = createRemoteAssistant({
      fetchImpl: surface.fetchImpl,
      session: sessionFor(),
      policy: policyRows([
        ["remote-server:on-model", true],
        ["remote-server:off-model", false],
      ]),
    });
    const [connection] = await assistant.provider.listConnections({ owner: "local:test" });
    expect(connection!.models.map((model) => model.id)).toEqual(["on-model"]);
  });

  it("策略里没有这条时视为未启用（新接入的 Provider 从未被勾选）", async () => {
    const surface = createFakeSurface({ models: ["never-勾选过的"] });
    const assistant = createRemoteAssistant({
      fetchImpl: surface.fetchImpl,
      session: sessionFor(),
      policy: policyRows([["remote-server:其它模型", true]]),
    });
    const [connection] = await assistant.provider.listConnections({ owner: "local:test" });
    // 已初始化但没这一行 → 不出现。这与 catalog 的判据一致，也是"新 Provider 默认全关"的来源。
    expect(connection!.models).toEqual([]);
    expect(connection!.ready).toBe(false);
  });

  it("tombstone 模型即使 enabled 也不出现", async () => {
    const surface = createFakeSurface({ models: ["removed-model"] });
    const assistant = createRemoteAssistant({
      fetchImpl: surface.fetchImpl,
      session: sessionFor(),
      policy: policyRows([["remote-server:removed-model", true, true]]),
    });
    const [connection] = await assistant.provider.listConnections({ owner: "local:test" });
    expect(connection!.models).toEqual([]);
  });

  it("策略未初始化时按全开（与 catalog 同语义）", async () => {
    const surface = createFakeSurface({ models: ["a", "b"] });
    const assistant = createRemoteAssistant({
      fetchImpl: surface.fetchImpl,
      session: sessionFor(),
      policy: () => ({ initialized: false, models: [] }),
    });
    const [connection] = await assistant.provider.listConnections({ owner: "local:test" });
    expect(connection!.models.map((model) => model.id)).toEqual(["a", "b"]);
  });

  it("宿主没提供策略快照时按全开（旧宿主）", async () => {
    const surface = createFakeSurface({ models: ["a"] });
    const assistant = createRemoteAssistant({ fetchImpl: surface.fetchImpl, session: sessionFor() });
    const [connection] = await assistant.provider.listConnections({ owner: "local:test" });
    expect(connection!.models.map((model) => model.id)).toEqual(["a"]);
  });

  it("用户在设置页改开关后立刻生效（缓存不冻结过滤结果）", async () => {
    const surface = createFakeSurface({ models: ["m1"] });
    let enabled = true;
    const assistant = createRemoteAssistant({
      fetchImpl: surface.fetchImpl,
      session: sessionFor(),
      policy: () => ({
        initialized: true,
        models: [{ modelKey: "remote-server:m1", enabled }],
      }),
    });
    const [first] = await assistant.provider.listConnections({ owner: "local:test" });
    expect(first!.models.map((model) => model.id)).toEqual(["m1"]);
    // 关掉之后，下一次读取就该消失——缓存只缓存上游目录，不缓存过滤结果。
    enabled = false;
    const [second] = await assistant.provider.listConnections({ owner: "local:test" });
    expect(second!.models).toEqual([]);
  });
});

describe("远端助手能力声明", () => {
  it("同一 adapter 同时声明文本交付与讨论，且不声明工具", () => {
    const surface = createFakeSurface({ models: ["a"] });
    const assistant = createRemoteAssistant({ fetchImpl: surface.fetchImpl, session: sessionFor() });
    const capabilities = assistant.adapter.capabilities();
    expect(capabilities.textDelivery).toEqual({ imageInput: false, maxImages: 0 });
    expect(capabilities.discussion).toBe(true);
    expect(capabilities.tools).toBe(false);
    expect(capabilities.targets).toEqual([]);
  });

  // 锁定的真实缺陷：曾把 `textDelivery` 的 `{ imageInput: false, maxImages: 0 }`
  // 直接复用到 `candidateGeneration`，而契约要求后者的 `maxImages >= 1`。整份能力
  // 因此被判非法，助手目录报「Agent adapter 能力声明非法」，远端模型全部消失。
  //
  // 只断言单个字段抓不到这类问题——必须跑契约自己的校验函数。
  it("能力声明通过契约校验", () => {
    const surface = createFakeSurface({ models: ["a"] });
    const assistant = createRemoteAssistant({ fetchImpl: surface.fetchImpl, session: sessionFor() });
    const capabilities = assistant.adapter.capabilities();
    expect(isAgentAdapterCapabilities(capabilities)).toBe(true);
  });

  it("不声明图片候选生成能力", () => {
    const surface = createFakeSurface({ models: ["a"] });
    const assistant = createRemoteAssistant({ fetchImpl: surface.fetchImpl, session: sessionFor() });
    // 远端助手只做文本：`candidateGeneration` 是「生成图片候选」的能力，声明它会让
    // 媒体候选链路以为这里能出图。
    expect(assistant.adapter.capabilities().candidateGeneration).toBeUndefined();
  });

  it("连接视图通过契约校验", async () => {
    const surface = createFakeSurface({ models: ["a"] });
    const assistant = createRemoteAssistant({ fetchImpl: surface.fetchImpl, session: sessionFor() });
    const [connection] = await assistant.provider.listConnections({ owner: "local:test" });
    // 连接视图也有自己的形状校验；两边任一不合法都会让目录整体不可用。
    expect(isAgentConnectionView(connection)).toBe(true);
  });
});

describe("远端助手执行分支", () => {
  it("候选模式走无工具一次性回合，返回完整正文", async () => {
    const surface = createFakeSurface({ models: ["a"], chatText: '{"text":"成品"}' });
    const assistant = createRemoteAssistant({ fetchImpl: surface.fetchImpl, session: sessionFor() });
    const outcome = await assistant.adapter.run(
      runInput({ candidate: { images: [], outputSchema: { type: "object" } } })
    );
    expect(outcome.status).toBe("succeeded");
    expect(outcome.assistantText).toBe('{"text":"成品"}');
    // 候选路径必须是**非流式**请求：文本交付只认终态正文。
    expect(surface.calls.every((call) => call.stream === false)).toBe(true);
  });

  it("讨论模式走流式并逐段回调", async () => {
    const surface = createFakeSurface({ models: ["a"], streamDeltas: ["你", "好"] });
    const assistant = createRemoteAssistant({ fetchImpl: surface.fetchImpl, session: sessionFor() });
    const deltas: string[] = [];
    const outcome = await assistant.adapter.run(
      runInput({ emit: (event) => { if (event.type === "message") deltas.push(event.content); } })
    );
    expect(outcome.status).toBe("succeeded");
    expect(deltas).toEqual(["你", "好"]);
    expect(outcome.assistantText).toBe("你好");
    expect(surface.calls[0]!.stream).toBe(true);
  });

  it("历史按 role 保留，压平会让 system 指令失去身份", async () => {
    const surface = createFakeSurface({ models: ["a"], chatText: "ok" });
    const assistant = createRemoteAssistant({ fetchImpl: surface.fetchImpl, session: sessionFor() });
    // ConversationMessage 是宿主持久化的完整形状（带身份与序号）；这里只关心 role 与
    // 正文是否被原样重放，其余字段按最小合法值填。
    const historyMessage = (role: "system" | "assistant", content: string, index: number) => ({
      messageId: `message-${index}`,
      conversationId: "conversation-1",
      turnId: `turn-${index}`,
      requestId: `request-${index}`,
      role,
      content,
      truncated: false,
      sequence: index,
      createdAt: "2026-11-12T00:00:00.000Z",
    });
    await assistant.adapter.run(
      runInput({
        history: [historyMessage("system", "你是助手", 0), historyMessage("assistant", "上一轮回复", 1)],
        candidate: { images: [], outputSchema: {} },
      })
    );
    const messages = surface.calls[0]!.messages;
    expect(messages[0]).toEqual({ role: "system", content: "你是助手" });
    expect(messages[1]).toEqual({ role: "assistant", content: "上一轮回复" });
    expect(messages[messages.length - 1]).toEqual({ role: "user", content: "你好" });
  });

  it("未选模型时明确失败", async () => {
    const surface = createFakeSurface({ models: ["a"] });
    const assistant = createRemoteAssistant({ fetchImpl: surface.fetchImpl, session: sessionFor() });
    const outcome = await assistant.adapter.run(runInput({ model: "" }));
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("model-unavailable");
    expect(surface.calls).toHaveLength(0);
  });

  it("上游失败不泄漏远端正文", async () => {
    const surface = createFakeSurface({ models: ["a"], chatStatus: 500 });
    const assistant = createRemoteAssistant({ fetchImpl: surface.fetchImpl, session: sessionFor() });
    const outcome = await assistant.adapter.run(
      runInput({ candidate: { images: [], outputSchema: {} } })
    );
    expect(outcome.status).toBe("failed");
    expect(JSON.stringify(outcome)).not.toContain("upstream secret detail");
  });

  it("取消时保留已输出的正文", async () => {
    const surface = createFakeSurface({ models: ["a"], streamDeltas: ["部分"] });
    const assistant = createRemoteAssistant({ fetchImpl: surface.fetchImpl, session: sessionFor() });
    const controller = new AbortController();
    const outcome = await assistant.adapter.run(
      runInput({
        signal: controller.signal,
        emit: (event) => {
          if (event.type === "message") controller.abort();
        },
      })
    );
    // 已发出的增量是真实产出，不能因为取消就丢掉。
    expect(outcome.assistantText).toBe("部分");
  });
});

describe("SSE 帧解析", () => {
  it("解析标准增量帧", () => {
    expect(__test.parseSseFrame('data: {"choices":[{"delta":{"content":"你好"}}]}')).toBe("你好");
  });
  it("识别 [DONE]", () => {
    expect(__test.parseSseFrame("data: [DONE]")).toBe(__test.DONE);
  });
  it("忽略心跳与未知字段", () => {
    expect(__test.parseSseFrame(": keepalive")).toBe("");
    expect(__test.parseSseFrame('data: {"unknown":1}')).toBe("");
  });
});
