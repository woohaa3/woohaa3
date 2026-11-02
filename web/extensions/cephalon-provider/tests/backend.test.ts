import { describe, expect, it, vi } from "vitest";
import type { PptaskProvider } from "@sdppp/pptask";
import { createCephalonProviderPlugin, createCephalonRegistration, CEPHALON_CONFIG } from "../src/backend.js";
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
