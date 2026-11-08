/**
 * RunningHub 插件测试
 * （change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 4.1–4.3 / design D1/D5）。
 */
import { describe, expect, it, vi } from "vitest";
import { createRunningHubRegistration } from "../src/backend.js";
import { createFingerprintGuardedFetch, fingerprintTemplate, TemplateChangedError } from "../src/template-guard.js";
import { findRunningHubModel, pickRunningHubRoute, prepareRunningHubInput, runningHubModelDefinitions } from "../src/shared.js";

describe("RunningHub API 逻辑模型清单（任务 1.2/1.3）", () => {
  it("纳管四族、合并 t2i/i2i，且不出现 App 模型", () => {
    const defs = runningHubModelDefinitions();
    expect(defs.length).toBeGreaterThanOrEqual(24);
    expect(new Set(defs.map((d) => d.providerId))).toEqual(new Set(["runninghub"]));
    expect(defs.every((d) => d.providerModelId.startsWith("api/"))).toBe(true);
    const families = new Set(defs.map((d) => d.title));
    expect([...families].some((title) => title?.includes("Seedance"))).toBe(true);
    expect(defs.find((d) => d.providerModelId === "api/seedream-v5-pro")?.modelType).toBe("image");
  });

  it("按输入路由：无图 → t2i；有图 → i2i；多素材 → multimodal", () => {
    const seedream = findRunningHubModel("api/seedream-v5-pro")!;
    expect(pickRunningHubRoute(seedream, { prompt: "x", parameters: {}, references: [] }).endpoint).toBe("seedream-v5-pro/text-to-image");
    expect(
      pickRunningHubRoute(seedream, {
        prompt: "x",
        parameters: {},
        references: [{ role: "reference_image", mediaKind: "image", mediaType: "image/png", url: "https://a/1.png" }]
      }).endpoint
    ).toBe("seedream-v5-pro/image-to-image");

    const seedance = findRunningHubModel("api/bytedance/seedance-2.0-global")!;
    expect(pickRunningHubRoute(seedance, { prompt: "x", parameters: {}, references: [] }).endpoint).toBe(
      "bytedance/seedance-2.0-global/text-to-video"
    );
    expect(
      pickRunningHubRoute(seedance, {
        prompt: "x",
        parameters: {},
        references: [
          { role: "reference_image", mediaKind: "image", mediaType: "image/png", url: "https://a/1.png" },
          { role: "reference_image", mediaKind: "image", mediaType: "image/png", url: "https://a/2.png" }
        ]
      }).endpoint
    ).toBe("bytedance/seedance-2.0-global/multimodal-video");
  });

  it("ultra 由 quality 路由，且不进入 provider 字段", () => {
    const model = findRunningHubModel("api/rhart-image-n-pro-official")!;
    const route = pickRunningHubRoute(model, {
      prompt: "x",
      parameters: { quality: "ultra" },
      references: [{ role: "reference_image", mediaKind: "image", mediaType: "image/png", url: "https://a/1.png" }]
    });
    expect(route.endpoint).toBe("rhart-image-n-pro-official/edit-ultra");
    const fields = prepareRunningHubInput(model, route, {
      prompt: "x",
      parameters: { quality: "ultra", resolution: "2k" },
      references: [{ role: "reference_image", mediaKind: "image", mediaType: "image/png", url: "https://a/1.png" }]
    });
    expect(fields).not.toHaveProperty("quality");
    expect(fields).toMatchObject({ prompt: "x", resolution: "2k", imageUrls: ["https://a/1.png"] });
  });
});

describe("RunningHub prepareInput（任务 1.4 / design D1b/D4）", () => {
  function activate(): { prepareInput?: (input: never) => Record<string, unknown>; resolveProviderModel?: (input: never) => string } {
    return createRunningHubRegistration({ apiKey: "k" }) as never;
  }

  it("prompt 与参数进入 providerOptions.runninghub.input，媒体字段按 route 归位", () => {
    const provider = activate();
    const resolveProviderModel = provider.resolveProviderModel!;
    const prepareInput = provider.prepareInput!;
    const input = {
      providerModelId: "api/seedream-v5-pro",
      modelType: "image",
      prompt: "a cat",
      parameters: { resolution: "2k", aspectRatio: "16:9" },
      references: [{ role: "reference_image", mediaKind: "image", mediaType: "image/png", url: "https://a/1.png" }]
    };
    expect(resolveProviderModel(input as never)).toBe("api/seedream-v5-pro/image-to-image");
    const prepared = prepareInput(input as never) as { providerOptions: { runninghub: { input: Record<string, unknown> } } };
    // 面板语义（比例 + 档位）在这里翻成即梦的像素宽高；比例本身不再下发。
    expect(prepared.providerOptions.runninghub.input).toMatchObject({
      prompt: "a cat",
      resolution: "2k",
      width: 2848,
      height: 1600,
      imageUrls: ["https://a/1.png"]
    });
  });

  it("字段同时平铺到顶层（vendored provider 会用顶层 prompt 覆盖自定义字段）", () => {
    const provider = activate();
    const prepared = provider.prepareInput!({
      providerModelId: "api/bytedance/jimeng-4.6",
      modelType: "image",
      prompt: "a cat",
      parameters: {},
      references: []
    } as never) as Record<string, unknown>;
    // 顶层 prompt 必须存在：worker 把整份 input 当作 options 传给 imageInput，
    // 后者用顶层 options.prompt 覆盖 providerOptions.runninghub.input.prompt。
    expect(prepared.prompt).toBe("a cat");
    expect((prepared.providerOptions as { runninghub: { input: Record<string, unknown> } }).runninghub.input.prompt).toBe("a cat");
  });
});

describe("RunningHub 插件装载", () => {
  it("apiKey 来自自己的配置段：有值即可用，没有值注册为不可用", async () => {
    const { createRunningHubProviderPlugin, RUNNINGHUB_CONFIG } = await import("../src/backend.js");
    expect(RUNNINGHUB_CONFIG.fields.apiKey).toMatchObject({ secret: true, legacyEnv: "RUNNINGHUB_API_KEY" });
    const registered: Array<{ available: boolean }> = [];
    const ctx = {
      log: { scope: () => () => undefined },
      generation: { register: (provider: never) => (registered.push(provider), () => undefined) },
      effect: (execute: () => unknown) => execute(),
      // 插件现在也注册「刷新可用模型」路由（见 refresh-route）：这两个注入在真实宿主里由网关提供。
      gateway: { route: () => () => undefined },
      access: {},
      storage: { bucket: () => ({ head: async () => null, get: async () => { throw new Error("unused"); } }) },
      exposer: { register: () => () => undefined }
    } as never;
    for (const input of [{ apiKey: "secret" }, {}]) {
      const config = RUNNINGHUB_CONFIG["~standard"].validate(input);
      if (!("value" in config)) throw new Error("config invalid");
      createRunningHubProviderPlugin().apply(ctx, config.value);
    }
    expect(registered.map((provider) => provider.available)).toEqual([true, false]);
  });

  it("同一份 Key 投影文字目录、固定文字端点与独立临时图床", async () => {
    const { createRunningHubRegistration, createRunningHubProviderPlugin, RUNNINGHUB_CONFIG } = await import("../src/backend.js");
    const registration = createRunningHubRegistration({ apiKey: "k" });
    expect(registration.models.some(model => model.providerModelId === "llm/glm/glm-5.2" && model.modelType === "language")).toBe(true);
    expect(registration.models.some(model => model.providerModelId === "api/bytedance/jimeng-4.6")).toBe(true);
    expect(registration.serviceConnectionFactory).toMatchObject({
      protocols: ["chat-completions"],
      assistantProtocol: "chat-completions",
      endpoints: { "chat-completions": "https://llm.runninghub.ai/v1" }
    });
    expect(registration.languageCapabilities?.("llm/glm/glm-5.2")).toEqual({ tools: true, imageInput: false, streaming: true });
    expect(registration.languageCapabilities?.("llm/missing")).toBeUndefined();

    const registered: Array<{ exposerId: string; temporaryHosting?: { category: string; ready: () => boolean } }> = [];
    const ctx = {
      log: { scope: () => () => undefined },
      generation: { register: () => () => undefined },
      effect: (execute: () => unknown) => execute(),
      gateway: { route: () => () => undefined },
      access: {},
      storage: { bucket: () => ({ head: async () => null, get: async () => { throw new Error("unused"); } }) },
      exposer: { register: (exposer: never) => (registered.push(exposer), () => undefined) }
    } as never;
    const parsed = RUNNINGHUB_CONFIG["~standard"].validate({ apiKey: "secret" });
    if (!("value" in parsed)) throw new Error("config invalid");
    createRunningHubProviderPlugin().apply(ctx, parsed.value);
    expect(registered[0]).toMatchObject({ exposerId: "runninghub-temporary", temporaryHosting: { category: "provider" } });
    expect(registered[0]!.temporaryHosting!.ready()).toBe(true);
  });

  it("站点状态：没配 API Key 时报 degraded 与诊断，配上后恢复健康", async () => {
    const { createRunningHubProviderPlugin, RUNNINGHUB_CONFIG } = await import("../src/backend.js");
    const plugin = createRunningHubProviderPlugin();
    const config = (input: Record<string, unknown>) => {
      const parsed = RUNNINGHUB_CONFIG["~standard"].validate(input);
      if (!("value" in parsed)) throw new Error("config invalid");
      return parsed.value;
    };

    expect(plugin.health?.(config({ apiKey: "secret" }))).toBeUndefined();
    // 空串与纯空白同样视为未配置，与 registration.available 的判据一致。
    for (const input of [{}, { apiKey: "" }, { apiKey: "   " }]) {
      expect(plugin.health?.(config(input))).toEqual({
        state: "degraded",
        diagnostics: [
          { code: "provider-credentials-missing", message: "未配置 API Key，RunningHub 模型与临时图床当前不可执行" }
        ]
      });
    }
  });
});

describe("RunningHub API 模型执行（任务 4.2 / design D1b）", () => {
  /** 激活插件并取注册的 provider（用于 prepareInput）。 */
  function activateProvider(): { prepareInput?: (input: never) => Record<string, unknown> } {
    return createRunningHubRegistration({ apiKey: "k" }) as never;
  }

  /** 用 fetch mock 驱动真实 vendored provider：提交 → 轮询 → 结果 materialize。 */
  async function runModel(input: {
    modelType: "image" | "video";
    logicalId: string;
    routeEndpoint: string;
    parameters: Record<string, unknown>;
    prompt?: string;
  }): Promise<{ startedUrl: string; startedBody: Record<string, unknown>; result: unknown }> {
    const calls: Array<{ url: string; body: unknown }> = [];
    let statusCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: u, body });
      if (u.endsWith(`/${input.routeEndpoint}`)) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
        return Response.json({ taskId: "task-1", status: "QUEUED" });
      }
      if (u.endsWith("/query")) {
        statusCalls += 1;
        return Response.json(
          statusCalls === 1
            ? { taskId: "task-1", status: "RUNNING" }
            : { taskId: "task-1", status: "SUCCESS", results: [{ url: "https://files.test/out.bin" }] }
        );
      }
      if (u === "https://files.test/out.bin") {
        return new Response(new Uint8Array([9, 9]), { headers: { "content-type": input.modelType === "video" ? "video/mp4" : "image/png" } });
      }
      throw new Error(`Unexpected request: ${u}`);
    });

    const { createRunninghubProvider } = await import("../src/provider/index.js");
    const { createMemoryJobRepository } = await import("@sdppp/pptask");
    const provider = createRunninghubProvider({
      apiKey: "test-key",
      fetch: fetchMock as never,
      jobRepository: createMemoryJobRepository(),
      pollIntervalMs: 1
    });
    // 走插件的 prepareInput（含顶层平铺），再喂给真实 provider —— 覆盖「插件 → provider」整条链。
    const plugin = activateProvider();
    const prepared = plugin.prepareInput!({
      providerModelId: `api/${input.logicalId}`,
      modelType: input.modelType,
      prompt: input.prompt ?? "a cat",
      parameters: input.parameters,
      references: []
    } as never) as Record<string, unknown>;
    const model =
      input.modelType === "video"
        ? provider.videoModel(`api/${input.routeEndpoint}`)
        : provider.imageModel(`api/${input.routeEndpoint}`);
    const job = await provider.jobs.start({ model: model as never, input: prepared });
    const result = await job.wait();
    const started = calls.find((call) => call.url.endsWith(`/${input.routeEndpoint}`))!;
    return { startedUrl: started.url, startedBody: started.body as Record<string, unknown>, result };
  }

  it("API 图片模型：payload、轮询与结果入库；不支持远端取消", async () => {
    const { startedUrl, startedBody, result } = await runModel({
      modelType: "image",
      logicalId: "seedream-v5-pro",
      routeEndpoint: "seedream-v5-pro/text-to-image",
      parameters: { model: "runninghub:api/seedream-v5-pro", resolution: "2k", aspectRatio: "16:9" }
    });
    // payload：prompt + 上游认的字段；比例 + 档位在插件里已翻成像素，面板参数不再原样透传。
    expect(startedUrl).toBe("https://www.runninghub.ai/openapi/v2/seedream-v5-pro/text-to-image");
    expect(startedBody).toMatchObject({ prompt: "a cat", resolution: "2k", width: 2848, height: 1600 });
    expect((result as { images: Uint8Array[] }).images[0]).toEqual(new Uint8Array([9, 9]));

    // API 模型不支持远端取消：实现里没有 doCancel（仅 App 有）。
    const { createRunninghubProvider } = await import("../src/provider/index.js");
    const { createMemoryJobRepository } = await import("@sdppp/pptask");
    const provider = createRunninghubProvider({ apiKey: "k", fetch: (async () => Response.json({})) as never, jobRepository: createMemoryJobRepository() });
    const impl = provider.imageModel("api/seedream-v5-pro/text-to-image") as unknown as { doCancel?: unknown };
    expect(impl.doCancel).toBeUndefined();
  });

  it("API 视频模型：payload 用 video 字段并走 /query 轮询", async () => {
    const { startedUrl, startedBody } = await runModel({
      modelType: "video",
      logicalId: "bytedance/seedance-2.0-global",
      routeEndpoint: "bytedance/seedance-2.0-global/text-to-video",
      parameters: { model: "runninghub:api/bytedance/seedance-2.0-global", resolution: "720p", duration: "5" }
    });
    expect(startedUrl).toBe("https://www.runninghub.ai/openapi/v2/bytedance/seedance-2.0-global/text-to-video");
    expect(startedBody).toMatchObject({ prompt: "a cat", resolution: "720p", duration: "5" });
  });
});

describe("模板指纹守卫（任务 4.3 / design D5）", () => {
  it("指纹稳定且字段顺序无关", () => {
    expect(fingerprintTemplate({ a: 1, b: 2 })).toBe(fingerprintTemplate({ b: 2, a: 1 }));
    expect(fingerprintTemplate({ a: 1 })).not.toBe(fingerprintTemplate({ a: 2 }));
  });

  it("模板端点响应指纹不匹配时抛 template-changed", async () => {
    const body = { nodes: [{ nodeId: "1", fieldName: "steps", fieldValue: 20 }] };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    const guarded = createFingerprintGuardedFetch({
      fetchImpl: fetchImpl as never,
      fingerprints: { "123": "deadbeef" }
    });
    await expect(guarded("https://app.example/api/webapp/apiCallDemo?webappId=123")).rejects.toBeInstanceOf(TemplateChangedError);
  });

  it("模板未确认（无指纹）时拒绝静默解释", async () => {
    const guarded = createFingerprintGuardedFetch({
      fetchImpl: (async () => new Response("{}", { status: 200 })) as never,
      fingerprints: {}
    });
    await expect(guarded("https://app.example/api/webapp/apiCallDemo?webappId=999")).rejects.toMatchObject({ code: "template-changed" });
  });

  it("指纹匹配时放行；非模板请求原样透传", async () => {
    const body = { nodes: [] };
    const expected = fingerprintTemplate(body);
    const guarded = createFingerprintGuardedFetch({
      fetchImpl: (async () => new Response(JSON.stringify(body), { status: 200 })) as never,
      fingerprints: { "123": expected }
    });
    const ok = await guarded("https://app.example/api/webapp/apiCallDemo?webappId=123");
    expect(ok.status).toBe(200);

    const other = await createFingerprintGuardedFetch({
      fetchImpl: (async () => new Response("media", { status: 200 })) as never
    })("https://cdn.example/output.png");
    expect(await other.text()).toBe("media");
  });
});
