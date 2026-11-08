/**
 * 运行期模型发现与「刷新可用模型」路由。
 *
 * 刷新要能删掉真正下架的模型，同时不能凭一份过期快照误删线上还在的：
 * 判定用「registry + 仓库内补丁」为正面清单，站点目录页只当「还在」的补充证据。
 */
import { describe, expect, it } from "vitest";
import { createRunningHubProviderPlugin, RUNNINGHUB_REFRESH_PATH } from "../src/backend.js";
import { catalogLogicalIds, discoverRunningHubModels, registryEntries } from "../src/discovery.js";
import { findRunningHubModel, runningHubRegistry } from "../src/shared.js";

/** 上游 registry 的最小形状：两个操作合并成一个逻辑模型。 */
const REGISTRY = {
  version: "test",
  models: [
    {
      endpoint: "rhart-image-g-9/text-to-image",
      output_type: "image",
      name_cn: "GPT Image 9",
      params: [{ fieldKey: "prompt", type: "STRING", required: true }]
    },
    {
      endpoint: "rhart-image-g-9/edit",
      output_type: "image",
      name_cn: "GPT Image 9",
      params: [
        { fieldKey: "prompt", type: "STRING", required: true },
        { fieldKey: "imageUrls", type: "IMAGE", required: false }
      ]
    }
  ]
};

/** 站点目录页片段：只有一个模型（`seedream-v5-lite`）还在售（端点路径在页面里是带引号的字符串）。 */
const CATALOG_HTML = '<button>"/seedream-v5-lite/image-to-image"</button><a href="/call-api/standard-api">目录</a>';

/** 按 URL 分派：registry 回 JSON，目录页回 HTML。 */
function routingFetch(options: { registry?: unknown; catalog?: string | null } = {}) {
  return (async (url: string | URL) => {
    const target = String(url);
    if (target.endsWith("/v1/models")) {
      return new Response(JSON.stringify({
        object: "list",
        data: [{ id: "glm/glm-5.2", object: "model", capabilities: { chat: true, tools: true, vision: false, streaming: true } }]
      }), { status: 200 });
    }
    if (target.includes("standard-api")) {
      if (options.catalog === null) return new Response("nope", { status: 500 });
      return new Response(options.catalog ?? CATALOG_HTML, { status: 200 });
    }
    return new Response(JSON.stringify(options.registry ?? REGISTRY), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

function fakeResponse() {
  const state = { status: 0, body: "" };
  return {
    state,
    writeHead: (status: number) => {
      state.status = status;
    },
    end: (body: string) => {
      state.body = body;
    }
  };
}

function fakeContext() {
  const handlers: Array<(req: unknown, res: unknown) => Promise<boolean>> = [];
  const registered: Array<{ models: Array<{ providerModelId: string; notice?: string }> }> = [];
  return {
    handlers,
    registered,
    ctx: {
      log: { scope: () => () => undefined },
      generation: {
        register: (registration: { models: Array<{ providerModelId: string; notice?: string }> }) => {
          registered.push(registration);
          return () => undefined;
        }
      },
      effect: (execute: () => unknown) => execute(),
      gateway: {
        route: (_order: number, handler: (req: unknown, res: unknown) => Promise<boolean>) => {
          handlers.push(handler);
          return () => undefined;
        }
      },
      access: {
        authenticator: async () => ({ principalId: "admin" }),
        accessEnforcer: { assertAction: async () => undefined }
      },
      storage: {
        bucket: () => ({
          head: async () => null,
          get: async () => { throw new Error("unused"); }
        })
      },
      exposer: { register: () => () => undefined }
    } as never
  };
}

describe("RunningHub 模型发现", () => {
  it("registry 的两种形状都能读，非条目对象被过滤", () => {
    expect(registryEntries(REGISTRY)).toHaveLength(2);
    expect(registryEntries([{ endpoint: "a/b/text-to-image" }, { nope: 1 }])).toHaveLength(1);
    expect(registryEntries({})).toHaveLength(0);
  });

  it("目录页只当正向证据：页面里有的保留，两边都没有的移除", () => {
    expect([...catalogLogicalIds(CATALOG_HTML)]).toEqual(["seedream-v5-lite"]);
  });

  it("下架的删掉，站点仍在售的留着", async () => {
    const base = runningHubRegistry().models;
    const result = await discoverRunningHubModels({
      base,
      fetchImpl: routingFetch(),
      patchEntries: []
    });
    if (!result.ok) throw new Error(result.message);
    const ids = result.models.map((model) => model.id);
    // dola 是仓库登记过的「站点在售」（known-live）：不打标签、也不会被删。
    expect(ids).toEqual(["dola-Seedream-5.0-pro", "rhart-image-g-9", "seedream-v5-lite"]);
    expect(result.discovered).toBe(1);
    expect(result.liveOnly).toEqual(["seedream-v5-lite"]);
    expect(result.removed).not.toContain("dola-Seedream-5.0-pro");
    // 其余 26 个（registry 没有、页面也没有、也不是 known-live）移除。
    expect(result.removed).toHaveLength(26);
    expect(result.removed).toContain("bytedance/jimeng-4.6");
    expect(result.catalogChecked).toBe(true);
  });

  it("known-live 的模型即使目录页没列出也保留", async () => {
    const base = runningHubRegistry().models;
    const result = await discoverRunningHubModels({
      base,
      fetchImpl: routingFetch({ catalog: '<button>"/seedream-v5-lite/image-to-image"</button>' }),
      patchEntries: []
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.models.map((model) => model.id)).toContain("dola-Seedream-5.0-pro");
    expect(result.liveOnly).not.toContain("dola-Seedream-5.0-pro");
  });

  it("目录页取不到时不做移除（没有下架证据就不动）", async () => {
    const base = runningHubRegistry().models;
    const result = await discoverRunningHubModels({
      base,
      fetchImpl: routingFetch({ catalog: null }),
      patchEntries: []
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.catalogChecked).toBe(false);
    expect(result.removed).toHaveLength(0);
    expect(result.models).toHaveLength(base.length + 1);
  });

  it("registry 失败时不动现有目录", async () => {
    const base = runningHubRegistry().models;
    const httpError = (async () => new Response("nope", { status: 500 })) as unknown as typeof globalThis.fetch;
    expect(await discoverRunningHubModels({ base, fetchImpl: httpError })).toMatchObject({ ok: false });
    const badJson = (async () => new Response("not json", { status: 200 })) as unknown as typeof globalThis.fetch;
    expect(await discoverRunningHubModels({ base, fetchImpl: badJson })).toMatchObject({ ok: false });
    const empty = (async () => new Response(JSON.stringify({ models: [] }), { status: 200 })) as unknown as typeof globalThis.fetch;
    expect(await discoverRunningHubModels({ base, fetchImpl: empty })).toMatchObject({ ok: false });
  });
});

describe("刷新路由", () => {
  it("插件声明刷新入口，路径就是注册的那条", () => {
    const plugin = createRunningHubProviderPlugin();
    expect(plugin.modelRefresh?.path).toBe(RUNNINGHUB_REFRESH_PATH);
    expect(plugin.modelRefresh?.hint).toContain("registry");
  });

  it("鉴权通过 → 合并模型并回 200；刷新后新模型可解析", async () => {
    const { ctx, handlers, registered } = fakeContext();
    const plugin = createRunningHubProviderPlugin({ fetchImpl: routingFetch() });
    plugin.apply(ctx, { apiKey: "key" } as never);
    expect(handlers).toHaveLength(1);

    const res = fakeResponse();
    const handled = await handlers[0]!({ method: "POST", url: RUNNINGHUB_REFRESH_PATH }, res);
    expect(handled).toBe(true);
    expect(res.state.status).toBe(200);
    const body = JSON.parse(res.state.body) as { modelCount: number; message?: string };
    expect(body.message).toContain("新增 1 个");
    expect(body.message).toContain("移除");
    expect(body.modelCount).toBe(body.modelCount);

    expect(findRunningHubModel("api/rhart-image-g-9")).toBeDefined();
    // dola 属于仓库登记的「站点在售」：刷新后仍然在，并且不带标签。
    expect(findRunningHubModel("api/dola-Seedream-5.0-pro")).toBeDefined();
    expect(
      registered[0]!.models.find((model) => model.providerModelId === "api/dola-Seedream-5.0-pro")?.notice
    ).toBeUndefined();
    expect(registered[0]!.models.some((model) => model.providerModelId === "api/rhart-image-g-9")).toBe(true);
    // 公开清单没收录、站点仍在售的模型带标签（设置页列表上要能看出来）。
    expect(
      registered[0]!.models.find((model) => model.providerModelId === "api/seedream-v5-lite")?.notice
    ).toBe("站点在售");
  });

  it("别的路径不处理；未授权回 401", async () => {
    const { ctx, handlers } = fakeContext();
    const plugin = createRunningHubProviderPlugin({ fetchImpl: routingFetch() });
    plugin.apply(ctx, { apiKey: "key" } as never);
    expect(await handlers[0]!({ method: "GET", url: RUNNINGHUB_REFRESH_PATH }, fakeResponse())).toBe(false);

    const denied = fakeContext();
    (denied.ctx as unknown as { access: { authenticator: () => Promise<null> } }).access = { authenticator: async () => null };
    const deniedPlugin = createRunningHubProviderPlugin({ fetchImpl: routingFetch() });
    deniedPlugin.apply(denied.ctx, { apiKey: "key" } as never);
    const res = fakeResponse();
    expect(await denied.handlers[0]!({ method: "POST", url: RUNNINGHUB_REFRESH_PATH }, res)).toBe(true);
    expect(res.state.status).toBe(401);
  });
});
