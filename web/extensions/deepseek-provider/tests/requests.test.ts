import { describe, expect, it, vi } from "vitest";
import type { PptaskProvider } from "@sdppp/pptask";
import { createDeepSeekProvider } from "../src/provider.js";
import { createDeepSeekRegistration } from "../src/backend.js";
import type { DeepSeekModel } from "../src/discovery.js";

const MODELS: DeepSeekModel[] = [
  {
    id: "deepseek-flash",
    title: "DeepSeek-V4.1-Flash",
    supportsVision: true,
    maxOutputTokens: 393216,
    reasoningEfforts: ["low", "high", "max"],
    defaultReasoningEffort: "high"
  },
  { id: "deepseek-v4-pro", title: "DeepSeek-V4-Pro", supportsVision: false, maxOutputTokens: 393216 }
];

type Call = { url: string; method: string; headers: Record<string, string>; body?: any };

function harness(reply: unknown = {
  choices: [{ message: { content: "你好" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2 }
}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init?.method ?? "GET", headers, ...(body === undefined ? {} : { body }) });
    return Response.json(reply);
  });
  const provider = createDeepSeekProvider({
    apiKey: "test-key",
    models: MODELS,
    fetch: fetchMock as unknown as typeof fetch
  });
  return { provider, calls };
}

function userPrompt(text = "你好") {
  return [{ role: "user", content: [{ type: "text", text }] }] as never;
}

describe("DeepSeek 请求", () => {
  it("文本走官方 /v1/chat/completions，带 Bearer", async () => {
    const { provider, calls } = harness();
    const result = await provider.languageModel("deepseek-flash").doGenerate?.({
      prompt: userPrompt(),
      maxOutputTokens: 32
    } as never);
    expect(calls[0]).toMatchObject({ url: "https://api.deepseek.com/v1/chat/completions", method: "POST" });
    expect(calls[0]?.headers.authorization).toBe("Bearer test-key");
    expect(calls[0]?.body).toMatchObject({ model: "deepseek-flash", max_tokens: 32 });
    expect(result && "content" in result ? result.content : []).toEqual([{ type: "text", text: "你好" }]);
  });

  it("思考模式默认开启时下发 thinking，并带上目录声明的档位", async () => {
    const { provider, calls } = harness();
    await provider.languageModel("deepseek-flash").doGenerate?.({
      prompt: userPrompt(),
      providerOptions: { deepseek: { thinking: "enabled", reasoningEffort: "max" } }
    } as never);
    expect(calls[0]?.body).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "max"
    });
    // 思考模式下采样参数不生效：不发送，避免面板值与真实行为不一致。
    expect(calls[0]?.body).not.toHaveProperty("temperature");
    expect(calls[0]?.body).not.toHaveProperty("top_p");
  });

  it("关闭思考模式时下发 disabled，并允许采样参数", async () => {
    const { provider, calls } = harness();
    await provider.languageModel("deepseek-flash").doGenerate?.({
      prompt: userPrompt(),
      temperature: 0.3,
      topP: 0.9,
      providerOptions: { deepseek: { thinking: "disabled" } }
    } as never);
    expect(calls[0]?.body).toMatchObject({ thinking: { type: "disabled" } });
    expect(calls[0]?.body).not.toHaveProperty("reasoning_effort");
  });

  it("未声明档位的模型不转发 reasoning_effort", async () => {
    const { provider, calls } = harness();
    await provider.languageModel("deepseek-v4-pro").doGenerate?.({
      prompt: userPrompt(),
      providerOptions: { deepseek: { reasoningEffort: "max" } }
    } as never);
    expect(calls[0]?.body).not.toHaveProperty("reasoning_effort");
  });

  it("越界档位在本地拒绝：官方会静默映射到最近档位，不能让它假装成功", async () => {
    const { provider } = harness();
    await expect(provider.languageModel("deepseek-flash").doGenerate?.({
      prompt: userPrompt(),
      providerOptions: { deepseek: { reasoningEffort: "minimal" } }
    } as never)).rejects.toThrow(/不支持思考强度「minimal」/);
  });

  it("参考图按目录声明的视觉能力追加到最后一条 user 消息", async () => {
    const { provider, calls } = harness();
    await provider.languageModel("deepseek-flash").doGenerate?.({
      prompt: userPrompt("这张图里有什么"),
      providerOptions: { deepseek: { urls: ["https://cdn.example/a.png", "https://cdn.example/b.png"] } }
    } as never);
    expect(calls[0]?.body.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "这张图里有什么" },
        { type: "image_url", image_url: { url: "https://cdn.example/a.png" } },
        { type: "image_url", image_url: { url: "https://cdn.example/b.png" } }
      ]
    });
  });

  it("没有视觉能力的模型不带图：上游对无视觉模型发图会 400", async () => {
    const { provider, calls } = harness();
    await provider.languageModel("deepseek-v4-pro").doGenerate?.({
      prompt: userPrompt(),
      providerOptions: { deepseek: { urls: ["https://cdn.example/a.png"] } }
    } as never);
    expect(JSON.stringify(calls[0]?.body.messages)).not.toContain("image_url");
  });

  it("max_tokens 不超过目录声明的输出上限", async () => {
    const { provider, calls } = harness();
    await provider.languageModel("deepseek-flash").doGenerate?.({
      prompt: userPrompt(),
      maxOutputTokens: 999_999_999
    } as never);
    expect(calls[0]?.body.max_tokens).toBe(393216);
  });

  it("JSON 输出翻译成 response_format", async () => {
    const { provider, calls } = harness();
    await provider.languageModel("deepseek-flash").doGenerate?.({
      prompt: userPrompt(),
      providerOptions: { deepseek: { jsonMode: true } }
    } as never);
    expect(calls[0]?.body.response_format).toEqual({ type: "json_object" });
  });

  it("画布任务路径：参数直接平铺在 input 上（没有 providerOptions 包装）", async () => {
    const { provider, calls } = harness();
    // task-service 的 buildInput 把面板参数平铺进 input：`{ prompt, ...parameters }`。
    await provider.languageModel("deepseek-flash").doGenerate?.({
      prompt: [{ role: "user", content: [{ type: "text", text: "写一句" }] }],
      system: "简洁",
      maxTokens: 256,
      jsonMode: true,
      thinking: "disabled",
      urls: ["https://cdn.example/a.png"]
    } as never);
    const body = calls[0]?.body;
    expect(body).toMatchObject({
      max_tokens: 256,
      response_format: { type: "json_object" },
      thinking: { type: "disabled" }
    });
    // system 提示词要变成 messages[0]，而不是作为字段发给上游。
    expect(body).not.toHaveProperty("system");
    expect(body.messages[0]).toEqual({ role: "system", content: "简洁" });
    expect(JSON.stringify(body.messages)).toContain("https://cdn.example/a.png");
  });

  it("只看文本：图片执行入口明确不存在", () => {
    const { provider } = harness();
    // AI SDK 的 customProvider 对未提供的模态抛 `No such imageModel`：不会静默返回一个假模型。
    expect(() => (provider as unknown as { imageModel: (id: string) => unknown }).imageModel("deepseek-flash"))
      .toThrow(/No such imageModel/);
  });

  it("个人来源凭据失效后不再发出请求", async () => {
    const calls: Array<string | null> = [];
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push(new Headers(init?.headers).get("authorization"));
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    });
    const { registration } = createDeepSeekRegistration({
      apiKey: "site-key",
      models: MODELS,
      fetchImpl: fetchImpl as typeof fetch
    });
    let active = true;
    const validate = async () => { if (!active) throw Object.assign(new Error("revoked"), { sourceStale: true }); };
    const source = registration.serviceConnectionFactory!.create({
      secret: "alice-key",
      endpoint: "https://api.deepseek.com",
      validate
    }) as PptaskProvider;
    await source.languageModel("deepseek-flash").doGenerate!({ prompt: userPrompt() } as never);
    expect(calls).toEqual(["Bearer alice-key"]);
    active = false;
    await expect(source.languageModel("deepseek-flash").doGenerate!({ prompt: userPrompt() } as never))
      .rejects.toMatchObject({ sourceStale: true });
    expect(calls).toHaveLength(1);
  });
});
