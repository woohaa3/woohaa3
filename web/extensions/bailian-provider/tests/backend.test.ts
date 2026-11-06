import { describe, expect, it, vi } from "vitest";
import {
  BAILIAN_CONFIG,
  bailianModelDefinitions,
  createBailianProviderPlugin,
  createBailianRegistration
} from "../src/backend.js";
import { BAILIAN_IMAGE_MODELS } from "../src/catalog.js";

const SECRET = "sk-bailian-secret-value";

type BailianConfig = {
  apiKey?: string;
  workspaceId: string;
  region: string;
  baseUrl: string;
};

function configOf(input: Record<string, unknown>): BailianConfig {
  const parsed = BAILIAN_CONFIG["~standard"].validate(input);
  if (!("value" in parsed)) throw new Error("配置校验失败");
  return parsed.value as BailianConfig;
}

/** 会记录事件的宿主 ctx 桩。 */
function makeContext() {
  const events: Array<Record<string, unknown>> = [];
  const registered: Array<{ available: boolean; models: Array<{ providerModelId: string; executable?: boolean }> }> = [];
  const routes: Array<{ order: number }> = [];
  const ctx = {
    log: { scope: () => (event: Record<string, unknown>) => events.push(event) },
    generation: {
      register: (provider: never) => {
        registered.push(provider);
        return () => undefined;
      }
    },
    gateway: {
      route: (order: number, _handler: never) => {
        routes.push({ order });
        return () => undefined;
      }
    },
    access: {},
    effect: (execute: () => unknown) => execute()
  } as never;
  return { ctx, events, registered, routes };
}

function listing(models: string[], total = models.length) {
  return Response.json({
    request_id: "req-1",
    output: {
      total,
      page_no: 1,
      page_size: 100,
      models: models.map((model) => ({ model, name: model }))
    }
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("百炼插件装配", () => {
  it("配置有 Key、业务空间、地域与地址四项", () => {
    expect(Object.keys(BAILIAN_CONFIG.fields)).toEqual(["apiKey", "workspaceId", "region", "baseUrl"]);
    expect(BAILIAN_CONFIG.fields.apiKey).toMatchObject({ kind: "string", secret: true, legacyEnv: "DASHSCOPE_API_KEY" });
    expect(BAILIAN_CONFIG.fields.workspaceId).toMatchObject({ kind: "string", default: "" });
    expect(BAILIAN_CONFIG.fields.region).toMatchObject({ default: "cn-beijing" });
    expect(BAILIAN_CONFIG.fields.baseUrl).toMatchObject({ default: "https://dashscope.aliyuncs.com" });
  });

  it("没填业务空间时用 API 地址；填了就换专属域名", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => listing([]));
    const plain = createBailianRegistration({ apiKey: SECRET, baseUrl: "https://dashscope.aliyuncs.com" });
    expect(plain.provider).toBeDefined();

    const { ctx } = makeContext();
    const plugin = createBailianProviderPlugin({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await plugin.apply(ctx, configOf({
      apiKey: SECRET,
      workspaceId: "ws-123",
      region: "ap-southeast-1",
      baseUrl: "https://dashscope.aliyuncs.com"
    }));
    await flush();
    // 发现请求必须打到业务空间域名，而不是配置里那个老域名。
    expect(String(fetchImpl.mock.calls[0]?.[0]))
      .toContain("https://ws-123.ap-southeast-1.maas.aliyuncs.com/api/v1/models");
  });

  it("注册卡片目录，schema 与默认值都来自卡片", () => {
    const definitions = bailianModelDefinitions();
    expect(definitions.map((definition) => definition.providerModelId))
      .toEqual(BAILIAN_IMAGE_MODELS.map((model) => model.id));
    for (const definition of definitions) {
      expect(definition.providerId).toBe("bailian");
      expect(definition.modelType).toBe("image");
      expect(definition.promptRequirement).toBe("required");
      expect(definition.cancel).toBe("local");
      expect(definition.inputSchema).toBeDefined();
    }
  });

  it("无 Key：仍注册但不可用，且不发发现请求", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => listing([]));
    const { ctx, registered } = makeContext();
    const plugin = createBailianProviderPlugin({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await plugin.apply(ctx, configOf({}));
    await flush();

    expect(registered).toHaveLength(1);
    expect(registered[0]?.available).toBe(false);
    // 设置页仍要列出全部模型（缺凭据是健康问题，不是目录问题）。
    expect(registered[0]?.models).toHaveLength(BAILIAN_IMAGE_MODELS.length);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("激活时用 Key 发现一次，并注册刷新路由", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => listing(["qwen-image-3.0-pro", "wan2.7-image-pro"]));
    const { ctx, events, routes, registered } = makeContext();
    const plugin = createBailianProviderPlugin({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(plugin.modelRefresh?.path).toBe("/api/providers/bailian/refresh");

    await plugin.apply(ctx, configOf({ apiKey: SECRET }));
    await flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(routes).toHaveLength(1);
    expect(events.map((event) => event.event)).toContain("bailian-models-discovered");
    expect(events.map((event) => event.event)).toContain("bailian-plugin-activated");
    // 注册表不因发现而扩容：没有卡片的模型不会出现。
    expect(registered[0]?.models).toHaveLength(BAILIAN_IMAGE_MODELS.length);
  });

  it("上游没返回的卡片模型被标记不可执行，返回的保持可执行", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => listing(["qwen-image-3.0-pro"]));
    const { ctx, registered } = makeContext();
    const plugin = createBailianProviderPlugin({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await plugin.apply(ctx, configOf({ apiKey: SECRET }));
    await flush();

    const models = registered[0]!.models;
    const executableOf = (id: string) => models.find((model) => model.providerModelId === id)?.executable;
    expect(executableOf("qwen-image-3.0-pro")).toBe(true);
    expect(executableOf("wan2.7-image-pro")).toBe(false);
  });

  it("发现失败只报错，不动目录（不误伤可用模型）", async () => {
    const failThenOk = vi.fn(async (_url: string | URL | Request): Promise<Response> => {
      throw new Error("connect ECONNREFUSED");
    });
    const { ctx, events, registered } = makeContext();
    const plugin = createBailianProviderPlugin({ fetchImpl: failThenOk as unknown as typeof fetch });
    await plugin.apply(ctx, configOf({ apiKey: SECRET }));
    await flush();

    expect(events.map((event) => event.event)).toContain("bailian-model-discovery-failed");
    // 发现没跑通时不能把模型判死：否则一次网络抖动就让整块面板变灰。
    for (const model of registered[0]!.models) expect(model.executable).not.toBe(false);
  });

  it("凭据不外泄：事件里没有 Key", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => new Response(`unauthorized: ${SECRET}`, { status: 401 }));
    const { ctx, events } = makeContext();
    const plugin = createBailianProviderPlugin({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await plugin.apply(ctx, configOf({ apiKey: SECRET }));
    await flush();
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it("缺 Key 时健康状态为 degraded + provider-credentials-missing", () => {
    const plugin = createBailianProviderPlugin();
    expect(plugin.health?.(configOf({ apiKey: SECRET }))).toBeUndefined();
    for (const input of [{}, { apiKey: "" }, { apiKey: "   " }]) {
      expect(plugin.health?.(configOf(input))).toEqual({
        state: "degraded",
        diagnostics: [{ code: "provider-credentials-missing", message: "未配置 API Key，百炼模型当前不可执行" }]
      });
    }
  });
});
