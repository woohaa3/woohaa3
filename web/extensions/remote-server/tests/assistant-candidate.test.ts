/**
 * 文本候选的结构化输出：schema 必须真的发给模型，模型返回的噪声必须被容忍。
 *
 * 锁定的真实故障：文本节点报「助手未返回结构化文本正文」。根因不是解析太严，而是
 * adapter 只用 `intent.prompt`、忽略了宿主合成好的 `prepared.messages`——模型根本
 * 不知道要输出什么形状，于是回一段散文。
 *
 * 契约对此有明确规定：「通道只消费它：不得再按业务 mode 构造角色提示词」。
 */
import { describe, expect, it } from "vitest";
import type { AgentAdapterRunInput } from "@woohaa3/contracts";
import {
  createRemoteAssistant,
  extractJsonObject,
  REMOTE_ASSISTANT_CONNECTION_ID,
} from "../src/backend/assistant/index.js";
import { REMOTE_ASSISTANT_ADAPTER_ID } from "../src/shared.js";

type ChatCall = { model: string; messages: Array<{ role: string; content: string }>; stream: boolean };

function createSurface(options: { models?: string[]; chatText?: string } = {}) {
  const calls: ChatCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/models")) {
      return new Response(
        JSON.stringify({ data: (options.models ?? ["m"]).map((id) => ({ id, object: "model" })) }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.endsWith("/v1/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as ChatCall;
      calls.push({ model: body.model, messages: body.messages ?? [], stream: Boolean(body.stream) });
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: options.chatText ?? "{}" } }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const session = async () => ({ serverUrl: "http://10.0.0.5:8080", token: "t" });

/** 一个带规范消息与候选输出契约的 prepared 回合（宿主合成的形状）。 */
function prepared(name = "prepared") {
  return {
    schemaVersion: 1 as const,
    roleRef: { extensionId: "remote-server", roleId: "text" },
    messages: [
      { role: "system" as const, content: "你是文本作者，只产出成品正文。" },
      { role: "user" as const, content: "写一句关于秋天的短诗" },
    ],
    tools: [],
    nativeCapabilities: [],
    output: { kind: "candidate" as const, schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    inputDigest: name,
    contextDigest: name,
    attachmentDigests: [],
    target: { canvasId: "canvas-1", nodeId: "node-1", mode: "text" as const },
    preparedHash: name,
  };
}

function candidateInput(overrides: Partial<AgentAdapterRunInput> = {}): AgentAdapterRunInput {
  return {
    owner: "local:test",
    canvasId: "canvas-1",
    conversationId: "c1",
    turnId: "t1",
    requestId: "r1",
    intent: { action: "discuss", canvasId: "canvas-1", nodeId: "node-1", mode: "text", model: "m", prompt: "写一句关于秋天的短诗" },
    connection: {
      connectionId: REMOTE_ASSISTANT_CONNECTION_ID,
      adapterId: REMOTE_ASSISTANT_ADAPTER_ID,
      configRevision: 1,
      credentialEpoch: 0,
    },
    history: [],
    signal: new AbortController().signal,
    emit: () => undefined,
    prepared: prepared() as never,
    candidate: { images: [], outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
    ...overrides,
  } as AgentAdapterRunInput;
}

describe("文本候选：schema 必须发给模型", () => {
  it("使用 prepared.messages 而不是只发 intent.prompt", async () => {
    const surface = createSurface({ chatText: '{"text":"秋风起"}' });
    const assistant = createRemoteAssistant({ fetchImpl: surface.fetchImpl, session });
    await assistant.adapter.run(candidateInput());
    const contents = surface.calls[0]!.messages.map((message) => message.content).join("\n");
    // 角色指令必须到达模型：只说"不得按 mode 构造提示词"是不够的，得真的把宿主编好的发出去。
    expect(contents).toContain("你是文本作者");
    expect(contents).toContain("写一句关于秋天的短诗");
  });

  it("把角色的输出 schema 明确告诉模型", async () => {
    const surface = createSurface({ chatText: '{"text":"秋风起"}' });
    const assistant = createRemoteAssistant({ fetchImpl: surface.fetchImpl, session });
    await assistant.adapter.run(candidateInput());
    const contents = surface.calls[0]!.messages.map((message) => message.content).join("\n");
    // 缺了这一段，模型会回散文，然后被解码器判成 candidate-invalid。
    expect(contents).toContain("JSON Schema");
    expect(contents).toContain('"text"');
  });
});

describe("文本候选：容忍模型输出的格式噪声", () => {
  const cases: Array<[string, string]> = [
    ["纯 JSON", '{"text":"正文"}'],
    ["代码围栏", '```json\n{"text":"正文"}\n```'],
    ["围栏无语言", '```\n{"text":"正文"}\n```'],
    ["前置解释", '好的，这是结果：\n{"text":"正文"}'],
    ["后置说明", '{"text":"正文"}\n希望你喜欢。'],
    ["前后都有", '结果如下：\n```json\n{"text":"正文"}\n```\n以上。'],
  ];
  for (const [name, raw] of cases) {
    it(`提取 ${name}`, () => {
      const extracted = extractJsonObject(raw);
      expect(extracted).not.toBeNull();
      expect(JSON.parse(extracted!)).toEqual({ text: "正文" });
    });
  }

  it("正文里含花括号与转义引号时不截断", () => {
    // 贪婪/非贪婪正则在这里都会错；必须按括号配对并跳过字符串内容。
    const raw = '{"text":"函数是 function(){ return \\"}\\" }"}';
    const extracted = extractJsonObject(raw);
    expect(extracted).not.toBeNull();
    expect(JSON.parse(extracted!).text).toBe('函数是 function(){ return "}" }');
  });

  it("完全没有对象时返回 null", () => {
    expect(extractJsonObject("这是一段散文，没有 JSON")).toBeNull();
  });

  it("数组不被当成候选对象", () => {
    expect(extractJsonObject("[1,2,3]")).toBeNull();
  });
});

describe("文本候选：噪声不影响交付", () => {
  it("模型带围栏也能成功交付", async () => {
    const surface = createSurface({ chatText: '```json\n{"text":"秋风起，落叶黄。"}\n```' });
    const assistant = createRemoteAssistant({ fetchImpl: surface.fetchImpl, session });
    const outcome = await assistant.adapter.run(candidateInput());
    expect(outcome.status).toBe("succeeded");
    // 交付层要求纯 JSON：adapter 必须先把噪声剥掉再交出去。
    expect(JSON.parse(outcome.assistantText!)).toEqual({ text: "秋风起，落叶黄。" });
  });

  it("真的没有 JSON 时按 candidate-invalid 失败并保留原文", async () => {
    const surface = createSurface({ chatText: "秋风起，落叶黄。" });
    const assistant = createRemoteAssistant({ fetchImpl: surface.fetchImpl, session });
    const outcome = await assistant.adapter.run(candidateInput());
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("candidate-invalid");
    // 原文保留，便于在详情里定位模型到底回了什么。
    expect(outcome.assistantText).toBe("秋风起，落叶黄。");
  });
});
