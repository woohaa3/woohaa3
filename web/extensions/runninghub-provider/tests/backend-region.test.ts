import { describe, expect, it } from "vitest";
import type { ExtensionDocumentRead, ExtensionDocumentStore, ExtensionDocumentValue } from "@woohaa3/contracts";
import {
  createRunningHubProviderPlugin,
  RUNNINGHUB_REFRESH_PATH,
  RUNNINGHUB_CONFIG
} from "../src/backend.js";
import { RUNNINGHUB_BALANCE_PATH } from "../src/balance.js";

const PUBLIC_URL = "https://rh-images.example.com/input/openapi/a.png?q-sign-time=1767852886%3B1767939286";

const REGISTRY = {
  models: [
    { endpoint: "seedream-v5.5/text-to-image", output_type: "image", name_cn: "Seedream 5.5 文生图", params: [{ fieldKey: "prompt", type: "STRING", required: true }] }
  ]
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** 区域探测用空文件上传；真正上传素材时文件非空。 */
async function isRegionProbe(body: BodyInit | null | undefined): Promise<boolean> {
  if (!(body instanceof FormData)) return false;
  const file = body.get("file");
  return file instanceof Blob && file.size === 0;
}

function uploadProbeResponse(url: string): Response {
  return url.includes("www.runninghub.cn")
    ? json({ code: 1, msg: "file is required" })
    : json({ code: 1, msg: "ApiKey verification failed: API Key不存在" });
}

function fakeResponse() {
  const state = { status: 0, body: "" };
  return {
    state,
    writeHead: (status: number) => { state.status = status; },
    end: (body: string) => { state.body = body; }
  };
}

function fakeContext(documents?: ExtensionDocumentStore) {
  const handlers: Array<(req: unknown, res: unknown) => Promise<boolean>> = [];
  const registered: Array<{
    models: Array<{ providerModelId: string }>;
    serviceConnectionFactory?: { endpoints?: Record<string, string> };
  }> = [];
  const exposers: Array<{ expose: (input: never) => Promise<string> }> = [];
  return {
    handlers,
    registered,
    exposers,
    ctx: {
      log: { scope: () => () => undefined },
      generation: { register: (registration: never) => (registered.push(registration as never), () => undefined) },
      effect: (execute: () => unknown) => execute(),
      gateway: { route: (_order: number, handler: (req: unknown, res: unknown) => Promise<boolean>) => (handlers.push(handler), () => undefined) },
      access: { authenticator: async () => ({ principalId: "admin" }), accessEnforcer: { assertAction: async () => undefined } },
      storage: { bucket: () => ({ head: async () => ({ size: 3, contentType: "image/png" }), get: async () => ({ bytes: Uint8Array.of(1, 2, 3), contentType: "image/png" }) }) },
      exposer: { register: (exposer: never) => (exposers.push(exposer as never), () => undefined) },
      ...(documents ? { services: { documents } } : {})
    } as never
  };
}

function memoryDocuments(): ExtensionDocumentStore {
  let value: ExtensionDocumentValue | undefined;
  return {
    owner: () => "runninghub-provider",
    async get<T extends ExtensionDocumentValue = ExtensionDocumentValue>(key: string): Promise<ExtensionDocumentRead<T>> {
      return value === undefined
        ? { found: false as const }
        : { found: true as const, document: { key, value: value as T, revision: 1, updatedAt: new Date(0).toISOString() } };
    },
    async batch(operations) {
      for (const operation of operations) {
        if (operation.op === "delete") value = undefined;
        else value = operation.value;
      }
      return { ok: true as const, revisions: { "account/region": 1 } };
    },
    async scan() { return { entries: [], nextCursor: null }; },
    async schemaVersion() { return 1; },
    async setSchemaVersion() { /* no-op */ }
  };
}

describe("RunningHub 插件按区域接线", () => {
  it("国内站 Key：探测、上传、余额与目录刷新都走 .cn", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/uc/openapi/accountStatus")) {
        return url.includes("www.runninghub.cn")
          ? json({ code: 0, data: { remainMoney: "12", currency: "CNY", remainCoins: "1200", currentTaskCounts: "0", apiType: "NORMAL" } })
          : json({ code: 806, msg: "APIKEY_USER_NOT_FOUND" });
      }
      if (url.includes("raw.githubusercontent.com")) return json(REGISTRY);
      if (url.includes("call-api/standard-api")) return new Response("<html>rhart-image-g-9</html>", { status: 200 });
      if (url.endsWith("llm.runninghub.cn/v1/models")) return json({ object: "list", data: [{ id: "qwen/qwen3.8", capabilities: { chat: true, tools: true, vision: false, streaming: true } }] });
      if (url.endsWith("/media/upload/binary")) {
        if (await isRegionProbe(init?.body)) return uploadProbeResponse(url);
        return json({ code: 0, data: { type: "image", download_url: PUBLIC_URL } });
      }
      throw new Error(`Unexpected request: ${url} init=${String(init?.method)}`);
    }) as typeof globalThis.fetch;

    const { ctx, handlers, registered, exposers } = fakeContext();
    const plugin = createRunningHubProviderPlugin({ fetchImpl });
    await plugin.apply(ctx, { apiKey: "key" } as never);

    expect(registered[0]!.serviceConnectionFactory?.endpoints?.["chat-completions"]).toBe("https://llm.runninghub.cn/v1");
    const modelIds = registered[0]!.models.map((model) => model.providerModelId);
    expect(modelIds).toContain("llm/qwen/qwen3.8-flash-next");
    expect(modelIds).not.toContain("llm/anthropic/claude-opus-5");
    expect(modelIds).toContain("api/seedream-v5-pro");
    expect(modelIds).toContain("api/seedream-v5-flash");
    expect(modelIds).not.toContain("api/rhart-image-n-pro");
    expect(modelIds).not.toContain("api/rhart-image-g-2.5/flare");
    expect(modelIds).not.toContain("api/dola-Seedream-5.0-pro");
    expect(calls.filter(url => url.endsWith("/media/upload/binary"))).toEqual([
      "https://www.runninghub.ai/openapi/v2/media/upload/binary",
      "https://www.runninghub.cn/openapi/v2/media/upload/binary"
    ]);

    // 临时图床上传走国内站。
    await exposers[0]!.expose({ namespace: "media", key: "a", request: { mediaKind: "image", contentType: "image/png" } } as never);
    expect(calls).toContain("https://www.runninghub.cn/openapi/v2/media/upload/binary");

    // 余额路由也走国内站。
    const balanceResponse = fakeResponse();
    expect(await handlers[1]!({ method: "GET", url: RUNNINGHUB_BALANCE_PATH }, balanceResponse)).toBe(true);
    expect(balanceResponse.state.status).toBe(200);
    expect(JSON.parse(balanceResponse.state.body)).toMatchObject({ ok: true, balance: { remainMoney: 12 } });
    expect(calls).toContain("https://www.runninghub.cn/uc/openapi/accountStatus");
    expect(calls).not.toContain("https://www.runninghub.ai/uc/openapi/accountStatus");

    // 刷新目录走国内站的标准模型页与文字目录。
    const refreshResponse = fakeResponse();
    expect(await handlers[0]!({ method: "POST", url: RUNNINGHUB_REFRESH_PATH }, refreshResponse)).toBe(true);
    expect(calls).toContain("https://www.runninghub.cn/call-api/standard-api");
    expect(calls).toContain("https://llm.runninghub.cn/v1/models");
    expect(calls.some(url => url.includes("llm.runninghub.ai/v1/models"))).toBe(false);
  });

  it("区域无法确认时回退国际站，不阻止插件激活", async () => {
    const fetchImpl = (async () => { throw new Error("offline"); }) as unknown as typeof globalThis.fetch;
    const { ctx, registered } = fakeContext();
    await createRunningHubProviderPlugin({ fetchImpl }).apply(ctx, { apiKey: "key" } as never);
    expect(registered).toHaveLength(1);
    expect(registered[0]!.serviceConnectionFactory?.endpoints?.["chat-completions"]).toBe("https://llm.runninghub.ai/v1");
  });

  it("受控 region 覆盖跳过探测", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new Error("should not probe");
    }) as unknown as typeof globalThis.fetch;
    const { ctx, registered } = fakeContext();
    await createRunningHubProviderPlugin({ fetchImpl, region: "cn" }).apply(ctx, { apiKey: "key" } as never);
    expect(calls).toBe(0);
    expect(registered[0]!.serviceConnectionFactory?.endpoints?.["chat-completions"]).toBe("https://llm.runninghub.cn/v1");
  });

  it("持久化命中时不重复探测，重启后仍用上次区域", async () => {
    const documents = memoryDocuments();
    let probeCalls = 0;
    const firstFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/media/upload/binary") && await isRegionProbe(init?.body)) {
        probeCalls += 1;
        return uploadProbeResponse(url);
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof globalThis.fetch;
    const first = fakeContext(documents);
    await createRunningHubProviderPlugin({ fetchImpl: firstFetch }).apply(first.ctx, { apiKey: "key" } as never);
    expect(probeCalls).toBe(2);

    // 重启后：即使两个站都不可达，也应复用文档里的 cn，不再探测。
    const offline = (async () => { throw new Error("offline"); }) as unknown as typeof globalThis.fetch;
    const second = fakeContext(documents);
    await createRunningHubProviderPlugin({ fetchImpl: offline }).apply(second.ctx, { apiKey: "key" } as never);
    expect(probeCalls).toBe(2);
    expect(second.registered[0]!.serviceConnectionFactory?.endpoints?.["chat-completions"]).toBe("https://llm.runninghub.cn/v1");
  });

  it("testConnection 报告站点；无效、不可达与区域不明分别给出真实原因", async () => {
    const pluginFor = (fetchImpl: typeof globalThis.fetch) => createRunningHubProviderPlugin({ fetchImpl });

    const cnSuccess = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/media/upload/binary") && await isRegionProbe(init?.body)) return uploadProbeResponse(url);
      if (url.endsWith("/uc/openapi/accountStatus")) {
        return url.includes("www.runninghub.cn") ? json({ code: 0, data: { remainMoney: "1" } }) : json({ code: 806, msg: "APIKEY_USER_NOT_FOUND" });
      }
      return json({ code: 0, data: { remainMoney: "1", currency: "CNY" } });
    }) as typeof globalThis.fetch;
    await expect(pluginFor(cnSuccess).testConnection?.({ apiKey: "key" } as never)).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining("国内站")
    });

    const invalid = (async () => json({ code: 806, msg: "APIKEY_USER_NOT_FOUND" })) as typeof globalThis.fetch;
    await expect(pluginFor(invalid).testConnection?.({ apiKey: "key" } as never)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("均无效")
    });

    const unreachable = (async () => { throw new Error("offline"); }) as unknown as typeof globalThis.fetch;
    await expect(pluginFor(unreachable).testConnection?.({ apiKey: "key" } as never)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("无法确认")
    });

    const rejected = (async (input: string | URL | Request) => {
      const url = String(input);
      return url.includes("www.runninghub.cn") ? json({ code: 801, msg: "APIKEY_UNSUPPORTED_FREE_USER" }) : json({ code: 806, msg: "APIKEY_USER_NOT_FOUND" });
    }) as typeof globalThis.fetch;
    await expect(pluginFor(rejected).testConnection?.({ apiKey: "key" } as never)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining("国内站")
    });

    expect(RUNNINGHUB_CONFIG.fields.apiKey).toMatchObject({ secret: true });
  });
});
