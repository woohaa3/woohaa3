import { describe, expect, it, vi } from "vitest";
import type { PptaskProvider } from "@sdppp/pptask";
import { describeDeepSeekModel } from "../src/provider.js";
import { createDeepSeekProviderPlugin, createDeepSeekRegistration, DEEPSEEK_CONFIG } from "../src/backend.js";
import { parseModelList } from "../src/discovery.js";
import MODELS from "./fixtures/models.json";

const SECRET = "sk-deepseek-secret-value";

function configOf(input: Record<string, unknown>) {
  const parsed = DEEPSEEK_CONFIG["~standard"].validate(input);
  if (!("value" in parsed)) throw new Error("配置校验失败");
  return parsed.value as { apiKey?: string };
}

function makeContext() {
  const events: Array<Record<string, unknown>> = [];
  const registered: Array<{ available: boolean; models: unknown[] }> = [];
  const routes: Array<{ handler: (req: never, res: never) => Promise<boolean> }> = [];
  const ctx = {
    log: { scope: () => (event: Record<string, unknown>) => events.push(event) },
    generation: {
      register: (provider: never) => {
        registered.push(provider);
        return () => undefined;
      }
    },
    gateway: {
      route: (_order: number, handler: never) => {
        routes.push({ handler });
        return () => undefined;
      }
    },
    access: {},
    effect: (execute: () => unknown) => execute()
  } as never;
  return { ctx, events, registered, routes };
}

function catalog() {
  return parseModelList(MODELS);
}

describe("DeepSeek 插件装配", () => {
  it("配置只声明 secret apiKey，官方地址不做配置项", () => {
    expect(DEEPSEEK_CONFIG.fields.apiKey).toMatchObject({
      kind: "string",
      secret: true,
      legacyEnv: "DEEPSEEK_API_KEY"
    });
    expect(Object.keys(DEEPSEEK_CONFIG.fields)).toEqual(["apiKey"]);
  });

  it("无 Key：不注册可用 Provider，目录为空但仍登记", () => {
    const { registration } = createDeepSeekRegistration({});
    expect(registration.available).toBe(false);
    expect(registration.provider).toBeUndefined();
    expect(registration.models).toEqual([]);
  });

  it("有 Key：注册文本模型，描述带视觉上限与思考档位", async () => {
    const { registration } = createDeepSeekRegistration({ apiKey: SECRET, models: catalog() });
    expect(registration.available).toBe(true);
    expect(registration.models.map((model) => `${model.modelType}:${model.providerModelId}`)).toEqual([
      "language:deepseek-flash",
      "language:deepseek-v4-pro"
    ]);
    const flash = await registration.describeModel?.({ providerModelId: "deepseek-flash", modelType: "language" });
    expect(flash?.title).toBe("DeepSeek-V4.1-Flash");
    expect(flash?.capabilityFacts).toEqual({ reasoning: { supported: true, efforts: ["low", "high", "max"] } });
    const properties = flash?.inputSchema?.properties as Record<string, Record<string, unknown>>;
    expect(properties.urls).toMatchObject({ title: "参考图", maxItems: 8 });
    expect(properties.reasoningEffort).toMatchObject({ default: "high" });
    expect(properties.thinking).toMatchObject({ default: "enabled" });
    expect(properties.maxTokens).toMatchObject({ maximum: 393216 });
  });

  it("没有视觉能力的模型不给参考图控件", async () => {
    const { registration } = createDeepSeekRegistration({ apiKey: SECRET, models: catalog() });
    const pro = await registration.describeModel?.({ providerModelId: "deepseek-v4-pro", modelType: "language" });
    const properties = pro?.inputSchema?.properties as Record<string, unknown>;
    expect(properties.urls).toBeUndefined();
  });

  it("未声明档位的模型不给思考强度控件，也不声明推理能力", () => {
    const description = describeDeepSeekModel("bare", "language", { id: "bare", title: "bare", supportsVision: false });
    const properties = description.inputSchema?.properties as Record<string, unknown>;
    expect(properties.reasoningEffort).toBeUndefined();
    expect(description).not.toHaveProperty("capabilityFacts");
    expect(properties.thinking).toMatchObject({ default: "enabled" });
  });

  it("装配：有 Key 时发现一次，注册 provider 与刷新路由", async () => {
    const { ctx, events, registered, routes } = makeContext();
    const fetchImpl = vi.fn(async () => Response.json(MODELS));
    const plugin = createDeepSeekProviderPlugin({ fetchImpl: fetchImpl as typeof fetch });
    await plugin.apply!(ctx, configOf({ apiKey: SECRET }));
    expect(fetchImpl).toHaveBeenCalledWith("https://api.deepseek.com/models", expect.objectContaining({ method: "GET" }));
    expect(registered).toHaveLength(1);
    expect(registered[0]?.available).toBe(true);
    expect(registered[0]?.models).toHaveLength(2);
    expect(routes).toHaveLength(1);
    expect(events.map((event) => event.event)).toContain("deepseek-models-discovered");
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it("发现失败只记稳定诊断，不注册任何兜底模型", async () => {
    const { ctx, events, registered } = makeContext();
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const plugin = createDeepSeekProviderPlugin({ fetchImpl: fetchImpl as typeof fetch });
    await plugin.apply!(ctx, configOf({ apiKey: SECRET }));
    // 失败时目录保持空：宁可没有模型，也不登记一份代码里写死、可能与上游不符的清单。
    expect(registered[0]?.models).toEqual([]);
    expect(events.map((event) => event.event)).toContain("deepseek-model-discovery-failed");
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it("没有 Key 时 health 报 degraded，且不请求上游", async () => {
    const fetchImpl = vi.fn();
    const plugin = createDeepSeekProviderPlugin({ fetchImpl: fetchImpl as typeof fetch });
    expect(plugin.health?.(configOf({}))).toMatchObject({ state: "degraded" });
    expect(plugin.health?.(configOf({ apiKey: SECRET }))).toBeUndefined();
    const { ctx, registered } = makeContext();
    await plugin.apply!(ctx, configOf({}));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(registered[0]?.available).toBe(false);
  });

  it("服务来源声明固定的官方入口，不接受自填地址", () => {
    const { registration } = createDeepSeekRegistration({ apiKey: SECRET, models: catalog() });
    expect(registration.serviceConnectionFactory?.protocols).toEqual(["chat-completions"]);
    expect(registration.serviceConnectionFactory?.assistantProtocol).toBe("chat-completions");
    expect(registration.serviceConnectionFactory?.endpoints).toEqual({
      "chat-completions": "https://api.deepseek.com/v1"
    });
  });

  it("个人来源用自己的 Key 执行，站点 Provider 不受影响", async () => {
    const { registration } = createDeepSeekRegistration({ apiKey: SECRET, models: catalog() });
    const calls: Array<string | null> = [];
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push(new Headers(init?.headers).get("authorization"));
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    });
    const source = createDeepSeekRegistration({
      apiKey: SECRET,
      models: catalog(),
      fetchImpl: fetchImpl as typeof fetch
    }).registration.serviceConnectionFactory!.create({
      secret: "alice-key",
      endpoint: "https://api.deepseek.com",
      validate: async () => undefined
    }) as PptaskProvider;
    await source.languageModel("deepseek-flash").doGenerate!({ prompt: [], maxOutputTokens: 16 } as never);
    expect(calls).toEqual(["Bearer alice-key"]);
    // 站点 Provider 仍按自己那份目录注册，没有被个人来源改写。
    expect(registration.models.map((model) => model.providerModelId)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
  });

  it("刷新后目录原地替换：provider 看到新的输出上限", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    });
    const { registration, models } = createDeepSeekRegistration({
      apiKey: SECRET,
      models: catalog(),
      fetchImpl: fetchImpl as typeof fetch
    });
    const provider = registration.provider as PptaskProvider;
    // 刷新：目录原地替换成上游新事实（更小的输出上限）。
    models.splice(0, models.length, { id: "deepseek-flash", title: "新名", supportsVision: true, maxOutputTokens: 4096 });
    await provider.languageModel("deepseek-flash").doGenerate!({ prompt: [], maxOutputTokens: 99_999 } as never);
    expect(bodies[0]?.max_tokens).toBe(4096);
    expect(registration.models).toHaveLength(2);
  });
});
