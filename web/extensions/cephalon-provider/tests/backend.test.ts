import { describe, expect, it, vi } from "vitest";
import type { PptaskProvider } from "@sdppp/pptask";
import { createCephalonProviderPlugin, createCephalonRegistration, CEPHALON_CONFIG } from "../src/backend.js";
import { createCephalonProvider } from "../src/provider.js";
import { cephalonModelDefinitions, parseModelList } from "../src/discovery.js";
import MODELS from "./fixtures/models.json";

const SECRET = "sk-cephalon-secret-value";

function configOf(input: Record<string, unknown>) {
  const parsed = CEPHALON_CONFIG["~standard"].validate(input);
  if (!("value" in parsed)) throw new Error("配置校验失败");
  return parsed.value as { apiKey?: string };
}

/** 会记录事件的宿主 ctx 桩。 */
function makeContext() {
  const events: Array<Record<string, unknown>> = [];
  const registered: Array<{ available: boolean; models: unknown[] }> = [];
  const routes: Array<{ path: string; handler: (req: never, res: never) => Promise<boolean> }> = [];
  const ctx = {
    log: {
      scope: () => (event: Record<string, unknown>) => events.push(event)
    },
    generation: {
      register: (provider: never) => {
        registered.push(provider);
        return () => undefined;
      }
    },
    gateway: {
      route: (_order: number, handler: never) => {
        routes.push({ path: "", handler });
        return () => undefined;
      }
    },
    access: {},
    effect: (execute: () => unknown) => execute()
  } as never;
  return { ctx, events, registered, routes };
}

async function flush(): Promise<void> {
  // 插件在 apply 里 await 发现，这里只是让微任务与 mock 的 promise 链走完。
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("端脑云插件装配", () => {
  it("配置只声明 secret apiKey，没有 baseUrl", () => {
    expect(CEPHALON_CONFIG.fields.apiKey).toMatchObject({
      kind: "string",
      secret: true,
      legacyEnv: "CEPHALON_API_KEY"
    });
    expect(Object.keys(CEPHALON_CONFIG.fields)).toEqual(["apiKey"]);
  });

  it("无 Key：不注册可用 Provider，目录为空", async () => {
    const { registration } = createCephalonRegistration({});
    expect(registration.available).toBe(false);
    expect(registration.provider).toBeUndefined();
    expect(registration.models).toEqual([]);
  });

  it("有 Key：注册并执行一次发现", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => Response.json(MODELS));
    const { ctx, events, registered } = makeContext();
    const plugin = createCephalonProviderPlugin({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await plugin.apply(ctx, configOf({ apiKey: SECRET }));
    await flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://cephalon.cloud/user-center/v1/models");
    expect(registered).toHaveLength(1);
    expect(registered[0]?.available).toBe(true);
    expect(registered[0]?.models).toHaveLength(35);
    expect(events.map((event) => event.event)).toContain("cephalon-models-discovered");
    expect(events.map((event) => event.event)).toContain("cephalon-plugin-activated");
  });

  it("刷新失败保留旧目录，诊断不含 Key", async () => {
    let mode: "ok" | "fail" = "ok";
    const fetchImpl = vi.fn(async () => {
      if (mode === "ok") return Response.json(MODELS);
      // 上游把 Key 回显在错误体里，也不能出现在诊断或事件里。
      return new Response(`unauthorized: ${SECRET}`, { status: 401 });
    });
    const { ctx, events, registered } = makeContext();
    const plugin = createCephalonProviderPlugin({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await plugin.apply(ctx, configOf({ apiKey: SECRET }));
    await flush();
    const models = registered[0]!.models as unknown[];
    expect(models).toHaveLength(35);

    mode = "fail";
    // 刷新路由由 registerModelRefreshRoute 注册，这里直接调到插件内部逻辑：
    // 用第二次 apply 的注册项验证失败路径保留上一次的目录集合。
    const second = makeContext();
    await plugin.apply(second.ctx, configOf({ apiKey: SECRET }));
    await flush();
    expect(second.registered[0]?.models).toHaveLength(35);
    const failure = second.events.find((event) => event.event === "cephalon-model-discovery-failed");
    expect(failure).toBeDefined();
    const serialized = JSON.stringify([...events, ...second.events]);
    expect(serialized).not.toContain(SECRET);
  });

  it("平台下架后下一次成功发现即从目录消失", async () => {
    const catalog = parseModelList(MODELS);
    const { registration } = createCephalonRegistration({ apiKey: SECRET, models: catalog });
    expect(registration.models.map((model) => model.providerModelId)).toContain("seedance-2.5");
    // 刷新替换整份目录（与 apply/refresh 用的是同一段 splice 语义）。
    const listed = (MODELS as { data: Array<{ id: string }> }).data.filter((model) => model.id !== "seedance-2.5");
    registration.models.splice(
      0,
      registration.models.length,
      ...cephalonModelDefinitions(parseModelList({ data: listed }))
    );
    expect(registration.models.map((model) => model.providerModelId)).not.toContain("seedance-2.5");
    expect(registration.models.length).toBe(34);
  });

  it("缺 Key 时健康状态为 degraded + provider-credentials-missing", () => {
    const plugin = createCephalonProviderPlugin();
    expect(plugin.health?.(configOf({ apiKey: SECRET }))).toBeUndefined();
    for (const input of [{}, { apiKey: "" }, { apiKey: "   " }]) {
      expect(plugin.health?.(configOf(input))).toEqual({
        state: "degraded",
        diagnostics: [{ code: "provider-credentials-missing", message: "未配置 API Key，端脑云模型当前不可执行" }]
      });
    }
  });

  it("刷新路由与设置页声明一致", async () => {
    const fetchImpl = vi.fn(async () => Response.json(MODELS));
    const { ctx, routes } = makeContext();
    const plugin = createCephalonProviderPlugin({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(plugin.modelRefresh?.path).toBe("/api/providers/cephalon/refresh");
    await plugin.apply(ctx, configOf({ apiKey: SECRET }));
    // registerModelRefreshRoute 会调用 gateway.route 登记处理函数。
    expect(routes).toHaveLength(1);
  });

  it("凭据不外泄：错误与诊断只留稳定码", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED for header authorization: Bearer ${SECRET}`);
    });
    const { ctx, events } = makeContext();
    const plugin = createCephalonProviderPlugin({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await plugin.apply(ctx, configOf({ apiKey: SECRET }));
    await flush();
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain("cephalon-model-discovery-failed");
  });

  it("文本模型按 chat-completions 接入助手，端点固定", () => {
    const { registration } = createCephalonRegistration({ apiKey: SECRET, models: parseModelList(MODELS) });
    expect(registration.serviceConnectionFactory).toMatchObject({
      protocols: ["chat-completions"],
      assistantProtocol: "chat-completions",
      endpoints: { "chat-completions": "https://cephalon.cloud/user-center/v1/model" }
    });
  });

  it("助手能力只取平台声明的视觉证据", () => {
    const { registration } = createCephalonRegistration({ apiKey: SECRET, models: parseModelList(MODELS) });
    expect(registration.languageCapabilities?.("deepseek-v4-flash")).toEqual({ imageInput: true });
    expect(registration.languageCapabilities?.("deepseek-v4.1-flash")).toEqual({ imageInput: false });
    expect(registration.languageCapabilities?.("NanoBanana2")).toBeUndefined();
    expect(registration.languageCapabilities?.("missing-model")).toBeUndefined();
  });

  it("助手来源使用来源自己的 Key，仍只发往固定平台地址", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      return Response.json({ choices: [{ message: { content: "好的" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    });
    const validate = vi.fn(async () => undefined);
    const input = { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as never;
    const { registration } = createCephalonRegistration({
      apiKey: SECRET,
      models: parseModelList(MODELS),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const source = registration.serviceConnectionFactory!.create({
      secret: "sk-personal-source",
      endpoint: "https://cephalon.cloud/user-center/v1/model",
      validate
    }) as PptaskProvider;
    const result = await source.languageModel("deepseek-v4.1-flash").doGenerate?.(input);
    expect(result && "content" in result ? result.content : []).not.toHaveLength(0);
    expect(validate).toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://cephalon.cloud/user-center/v1/model/chat/completions",
      authorization: "Bearer sk-personal-source"
    });
  });

  it("注册项把描述交给 describeModel，并按需下载图片", async () => {
    const imageBytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://cdn.example/out.png") {
        return new Response(imageBytes, { headers: { "content-type": "image/png" } });
      }
      return Response.json({ data: [{ url: "https://cdn.example/out.png" }] });
    });
    const { registration } = createCephalonRegistration({
      apiKey: SECRET,
      models: parseModelList(MODELS),
      fetchImpl: fetchMock as unknown as typeof fetch
    });
    const model = registration.models.find((item) => item.providerModelId === "NanoBanana2")!;
    expect(registration.describeModel?.(model)).toMatchObject({ providerId: "cephalon", modelType: "image" });

    const provider = registration.provider as PptaskProvider;
    const result = await provider.imageModel("NanoBanana2").doGenerate?.({ prompt: "一只猫" } as never);
    expect(result && "images" in result ? result.images[0] : undefined).toEqual(imageBytes);
  });
});

describe("端脑云作为助手来源", () => {
  it("声明可信 assistant 协议，宿主才会生成 sdk-agent 绑定", () => {
    const { registration } = createCephalonRegistration({ apiKey: SECRET, models: parseModelList(MODELS) });
    const factory = registration.serviceConnectionFactory;
    // 没有这段声明时，这条连接只能给生成侧用，导演区等助手面板看不到它。
    expect(factory).toBeDefined();
    expect(factory?.protocols).toEqual(["chat-completions"]);
    expect(factory?.assistantProtocol).toBe("chat-completions");
    // 端点声明到模型前缀：OpenAI 兼容客户端自行追加 `/chat/completions`。
    expect(factory?.endpoints?.["chat-completions"]).toBe("https://cephalon.cloud/user-center/v1/model");
  });

  it("语言模型的图片能力取平台声明，不按名字推测", () => {
    const models = parseModelList(MODELS);
    const { registration } = createCephalonRegistration({ apiKey: SECRET, models });
    const language = models.filter(model => model.modelType === "language");
    const vision = language.find(model => model.supportsVision === true);
    const textOnly = language.find(model => model.supportsVision !== true);
    if (vision) expect(registration.languageCapabilities?.(vision.id)?.imageInput).toBe(true);
    if (textOnly) expect(registration.languageCapabilities?.(textOnly.id)?.imageInput).toBe(false);
    expect(registration.languageCapabilities?.("不存在的模型")).toBeUndefined();
  });

  it("文本与图片都只发往平台固定 origin，来源不能改写主机", async () => {
    const models = parseModelList(MODELS);
    const language = models.find(model => model.modelType === "language");
    const image = models.find(model => model.modelType === "image");
    if (!language || !image) return;
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return Response.json({ choices: [{ message: { content: "ok" } }], data: [{ url: "https://cdn.example/out.png" }] });
    }) as unknown as typeof globalThis.fetch;
    const handle = createCephalonProvider({ apiKey: SECRET, models, fetch: fetchImpl });
    await handle.languageModel(language.id).doGenerate?.({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } as never);
    expect(urls[0]).toBe("https://cephalon.cloud/user-center/v1/model/chat/completions");
    urls.length = 0;
    await handle.imageModel(image.id).doGenerate?.({ prompt: "hi" } as never);
    // 图片与文本同域：凭据只发往声明的平台主机。
    expect(urls[0]?.startsWith("https://cephalon.cloud/")).toBe(true);
  });
});
