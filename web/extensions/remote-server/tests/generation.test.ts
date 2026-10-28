/**
 * remote-server 的托管生成接入测试（change: 2026-10-20-reserve-remote-generation-provider，tasks 5.7）。
 *
 * 没有真实服务端可测：真实后端实现不在本 change。这里用进程内 fake Connect 服务锁住**客户端
 * 行为契约**：未实现/版本不匹配时休眠、登录后注册、目录字段映射、提交/轮询/取消、稳定失败码、
 * 会话清除翻转、刷新推进 catalogRevision、未知字段/类型降级、重复刷新不重复注册。
 */
import { describe, expect, it } from "vitest";
import type { GenerationProvider } from "@woohaa3/contracts";
import { isGenerationStableMediaResult } from "@woohaa3/contracts";
import type { PptaskProvider } from "@sdppp/pptask";
import { createRemoteServerPlugin } from "../src/backend/index.js";
import { RemoteGenerationError } from "../src/backend/generation/provider.js";
import {
  REMOTE_SERVER_GENERATION_REFRESH_ROUTE,
  REMOTE_SERVER_LOGIN_ROUTE,
  REMOTE_SERVER_LOGOUT_ROUTE
} from "../src/shared.js";
import { createFakeServer, type FakeGenerationTaskResult } from "./fake-server.js";

type HandlerResult = { status?: number; body: unknown };

/** 64 位十六进制：客户端媒体键的固定形状（generation-outputs/<sha256>.<ext>）。 */
function hex(char: string): string {
  return char.repeat(64);
}

const IMAGE_KEY = `generation-outputs/${hex("a")}.png`;
const POSTER_KEY = `generation-outputs/${hex("b")}.jpg`;

/** 最小宿主替身：只实现本扩展用到的面，并记录生成注册次数。 */
function createHost(options: { registerGeneration?: boolean } = {}) {
  const handlers = new Map<string, (input: { body: unknown; context: unknown }) => Promise<HandlerResult> | HandlerResult>();
  const capabilities = new Map<string, unknown>();
  const providers: GenerationProvider[] = [];
  const logEvents: Array<Record<string, unknown>> = [];
  const counts = { register: 0 };
  const undos: Array<() => void> = [];
  const host: Record<string, unknown> = {
    log: { scope: () => (event: Record<string, unknown>) => { logEvents.push(event); } },
    capabilities: {
      register: (id: string, value: unknown) => {
        capabilities.set(id, value);
        return () => capabilities.delete(id);
      }
    },
    services: {
      canvas: {
        requestNodeRun: async () => ({ ok: false as const, code: "unavailable", message: "test" }),
        requestNodeCancel: async () => ({ ok: false as const, code: "unavailable", message: "test" }),
        refreshSyncUpstream: async () => undefined
      }
    },
    storage: { register: () => () => undefined, unregister: () => undefined },
    telemetry: { registerExport: () => () => undefined, emit: () => undefined, query: async () => ({ events: [], nextCursor: null }), unregisterExport: () => undefined },
    marketplace: { register: () => () => undefined, unregister: () => undefined, list: () => [], resolve: () => undefined },
    effect: (run: () => (() => void) | void) => {
      const undo = run();
      if (typeof undo === "function") undos.push(undo);
    },
    webServer: {
      register: (registration: { route: string; handle: (input: { body: unknown; context: unknown }) => Promise<HandlerResult> | HandlerResult }) => {
        handlers.set(registration.route, registration.handle);
      },
      registerHttp: () => undefined,
      registerRawHttp: () => undefined
    }
  };
  // 生成注册面：与生产一致，`ctx.generation.register(provider)` 收到 provider。
  if (options.registerGeneration !== false) {
    host.generation = {
      register: (provider: GenerationProvider) => {
        counts.register += 1;
        providers.push(provider);
        return () => undefined;
      },
      unregister: () => undefined,
      list: () => providers,
      resolve: () => undefined,
      conversions: () => [],
      registerConversion: () => () => undefined
    };
  }
  return {
    host,
    handlers,
    capabilities,
    providers,
    logEvents,
    counts,
    async call(route: string, body: unknown = {}): Promise<HandlerResult> {
      const handler = handlers.get(route);
      if (!handler) throw new Error(`未注册 handler：${route}`);
      return handler({ body, context: {} });
    }
  };
}

function activate(options: {
  fake: ReturnType<typeof createFakeServer>;
  registerGeneration?: boolean;
  fetchImpl?: typeof globalThis.fetch;
  deployment?: () => { serverUrl: string | null; deviceToken: string | null; keyPrefix: string };
}) {
  const harness = createHost({ ...(options.registerGeneration === false ? { registerGeneration: false } : {}) });
  const definition = createRemoteServerPlugin({
    deployment: options.deployment ?? (() => options.fake.deployment),
    fetchImpl: options.fetchImpl ?? options.fake.fetch,
    generation: { pollIntervalMs: 5, clientTimeoutMs: 2000 }
  });
  void definition.apply(harness.host as never, {} as never);
  return harness;
}

/** 注册目录里的 Provider 句柄（测试里当作 pptask provider 使用）。 */
function pptaskOf(harness: ReturnType<typeof createHost>): PptaskProvider {
  const registration = harness.providers[0];
  if (!registration) throw new Error("没有注册生成 Provider");
  return registration.provider as PptaskProvider;
}

function statusOf(result: HandlerResult): { available: boolean; modelCount: number; catalogRevision: number; error: string | null } {
  const body = result.body as Record<string, unknown>;
  return {
    available: body.available === true,
    modelCount: typeof body.modelCount === "number" ? body.modelCount : -1,
    catalogRevision: typeof body.catalogRevision === "number" ? body.catalogRevision : -1,
    error: typeof body.error === "string" ? body.error : null
  };
}

/** 服务端目录里的一条文本模型（字段名照 proto 的 ProtoJSON）。 */
function textModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    modelKey: "server-text-1",
    providerId: "upstream-provider",
    providerModelId: "upstream-text",
    modelType: "language",
    title: "服务端文本模型",
    inputSchema: { type: "object", properties: { prompt: { type: "string" } } },
    defaultInput: { temperature: 0.3 },
    promptRequirement: "optional",
    cancel: "remote",
    taskTimeoutMs: 1234,
    interaction: { id: "generic-model", version: 1 },
    capabilityFacts: { reasoning: { supported: true, efforts: ["low"] } },
    capabilities: { operation: "task" },
    executable: true,
    schemaRevision: "7",
    configVersion: "3",
    ...overrides
  };
}

/** 服务端目录里的一条图像模型（带 bindings 与未知 interaction）。 */
function imageModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    modelKey: "server-image-1",
    modelType: "image",
    title: "服务端图像模型",
    bindings: [
      {
        field: "image",
        semantic: "reference-image",
        roles: ["reference"],
        mediaKinds: ["image"],
        mediaTypes: ["image/png"],
        maxItems: 2,
        valueFormat: "reference"
      }
    ],
    interaction: { id: "unknown-panel", version: 7 },
    executable: true,
    ...overrides
  };
}

function activateWithCatalog(options: {
  models: Array<Record<string, unknown>>;
  taskResult?: FakeGenerationTaskResult;
  rejectSubmitWith?: string;
  capabilities?: { protocolVersion?: number; features?: string[] };
  catalogRevision?: number;
  unimplemented?: boolean;
}) {
  const fake = createFakeServer({
    generation: {
      ...(options.unimplemented === true ? { unimplemented: true } : {}),
      ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
      catalog: { available: true, catalogRevision: options.catalogRevision ?? 1, models: options.models },
      ...(options.taskResult !== undefined ? { taskResult: options.taskResult } : {}),
      ...(options.rejectSubmitWith !== undefined ? { rejectSubmitWith: options.rejectSubmitWith } : {})
    }
  });
  const harness = activate({ fake });
  return { fake, harness };
}

async function loginAndRefresh(harness: ReturnType<typeof createHost>) {
  const login = await harness.call(REMOTE_SERVER_LOGIN_ROUTE, {});
  expect((login.body as { ok: boolean }).ok).toBe(true);
  const status = await harness.call(REMOTE_SERVER_GENERATION_REFRESH_ROUTE);
  return statusOf(status);
}

describe("服务端托管生成：休眠与注册", () => {
  it("宿主没有生成扩展点时安静跳过，不伪造 Provider", async () => {
    const fake = createFakeServer({ generation: { catalog: { models: [textModel()] } } });
    const harness = activate({ fake, registerGeneration: false });
    const status = statusOf(await harness.call(REMOTE_SERVER_GENERATION_REFRESH_ROUTE));
    expect(harness.providers).toHaveLength(0);
    expect(status).toMatchObject({ available: false, modelCount: 0 });
    expect(harness.logEvents.map((event) => event.event)).toContain("remote-generation-unavailable");
  });

  it("激活时只注册一次占位 Provider：available=false、空目录、走本机模型启停策略", () => {
    const fake = createFakeServer();
    const harness = activate({ fake });
    expect(harness.counts.register).toBe(1);
    const provider = harness.providers[0];
    expect(provider).toBeDefined();
    expect(provider?.available).toBe(false);
    expect(provider?.models).toEqual([]);
    // 不声明 server 权威：远端模型和其它 Provider 一样由本机策略决定启停。
    expect(provider?.selectionAuthority).toBeUndefined();
    expect(provider?.catalogRevision).toBe(0);
    expect(provider?.providerId).toBe("remote-server");
    expect(provider?.extensionId).toBe("remote-server");
  });

  it("服务端未实现（unimplemented）时保持休眠：info 级、不是 error、不动连接相位", async () => {
    const fake = createFakeServer({ generation: { unimplemented: true } });
    const harness = activate({ fake });
    const status = await loginAndRefresh(harness);
    expect(status).toMatchObject({ available: false, modelCount: 0 });
    expect(harness.providers).toHaveLength(1);
    expect(harness.providers[0]?.available).toBe(false);
    expect(harness.providers[0]?.models).toEqual([]);

    const dormant = harness.logEvents.filter((event) => event.event === "remote-generation-dormant");
    expect(dormant.length).toBeGreaterThan(0);
    // 「未实现」是 info 级的正常休眠；没有会话时是 debug（也不是 error）。
    expect(dormant.some((event) => event.code === "unimplemented" && event.level === "info")).toBe(true);
    for (const event of dormant) expect(["debug", "info"]).toContain(event.level);
    expect(harness.logEvents.some((event) => event.level === "error")).toBe(false);
    // 远端正文不进日志（只有稳定短语）。
    expect(JSON.stringify(harness.logEvents)).not.toContain("not implemented");
  });

  it("协议版本不匹配时保持休眠（不发目录请求）", async () => {
    const fake = createFakeServer({
      generation: { capabilities: { protocolVersion: 2 }, catalog: { models: [textModel()] } }
    });
    const harness = activate({ fake });
    const status = await loginAndRefresh(harness);
    expect(status.available).toBe(false);
    expect(status.modelCount).toBe(0);
    expect(fake.calls.some((call) => call.path.endsWith("/GetCatalog"))).toBe(false);
    expect(harness.logEvents.some((event) => event.code === "protocol-version")).toBe(true);
  });

  it("缺少 catalog feature 时保持休眠", async () => {
    const fake = createFakeServer({
      generation: { capabilities: { features: ["cancel"] }, catalog: { models: [textModel()] } }
    });
    const harness = activate({ fake });
    const status = await loginAndRefresh(harness);
    expect(status.available).toBe(false);
    expect(harness.logEvents.some((event) => event.code === "catalog-feature")).toBe(true);
  });

  it("空目录保持休眠", async () => {
    const fake = createFakeServer({ generation: { catalog: { available: true, models: [] } } });
    const harness = activate({ fake });
    const status = await loginAndRefresh(harness);
    expect(status).toMatchObject({ available: false, modelCount: 0 });
    expect(harness.providers[0]?.available).toBe(false);
  });

  it("catalog.available=false 时保持休眠，不注册空 Provider", async () => {
    const fake = createFakeServer({
      generation: { catalog: { available: false, reason: "not-configured", models: [textModel()] } }
    });
    const harness = activate({ fake });
    const status = await loginAndRefresh(harness);
    expect(status.available).toBe(false);
    expect(status.modelCount).toBe(0);
    expect(harness.providers[0]?.available).toBe(false);
  });
});

describe("服务端托管生成：目录归一", () => {
  it("登录后原地替换模型并翻转可用性（注册对象与数组引用都不变）", async () => {
    const fake = createFakeServer({
      generation: { catalog: { models: [imageModel()], catalogRevision: 4 } }
    });
    const harness = activate({ fake });
    const registration = harness.providers[0];
    const modelsArray = registration?.models;

    const status = await loginAndRefresh(harness);
    expect(status.available).toBe(true);
    expect(status.modelCount).toBe(1);
    expect(status.catalogRevision).toBeGreaterThan(0);
    expect(harness.counts.register).toBe(1);
    // 原地更新：同一个注册对象、同一个 models 数组。
    expect(harness.providers[0]).toBe(registration);
    expect(harness.providers[0]?.models).toBe(modelsArray);
  });

  it("字段映射：类型/title/inputSchema/defaultInput/capabilityFacts/capabilities 透传", async () => {
    const { harness } = activateWithCatalog({ models: [textModel(), imageModel()] });
    await loginAndRefresh(harness);
    const provider = harness.providers[0];
    const text = provider?.models.find((model) => model.providerModelId === "server-text-1");
    expect(text).toMatchObject({
      providerId: "remote-server",
      modelType: "language",
      title: "服务端文本模型",
      inputSchema: { type: "object", properties: { prompt: { type: "string" } } },
      defaultInput: { temperature: 0.3 },
      capabilityFacts: { reasoning: { supported: true, efforts: ["low"] } },
      capabilities: { operation: "task" },
      promptRequirement: "optional",
      cancel: "remote",
      taskTimeoutMs: 1234,
      interaction: { id: "generic-model", version: 1 }
    });
    // providerModelId 用服务端 model_key（含冒号的 key 会在解码时被拒）。
    expect(provider?.describe?.("server-text-1")).toBe(text);
  });

  it("bindings 合并进 capabilities.referenceInput.bindings，未知 interaction 归一 generic", async () => {
    const { harness } = activateWithCatalog({ models: [imageModel()] });
    await loginAndRefresh(harness);
    const image = harness.providers[0]?.models[0];
    expect(image?.modelType).toBe("image");
    expect(image?.capabilities).toMatchObject({
      referenceInput: {
        bindings: [
          {
            field: "image",
            semantic: "reference-image",
            roles: ["reference"],
            mediaKinds: ["image"],
            mediaTypes: ["image/png"],
            maxItems: 2,
            valueFormat: "reference"
          }
        ]
      }
    });
    // 未注册的 interaction 归一成 generic（避免整份目录 missing-plugin）。
    expect(image?.interaction).toEqual({ id: "generic-model", version: 1 });
    // 缺省 taskTimeoutMs 用客户端缺省值。
    expect(image?.taskTimeoutMs).toBe(8 * 60_000);
  });

  it("未知 model_type / 非法 model_key / 未知字段单条降级，不影响其它模型", async () => {
    const { harness } = activateWithCatalog({
      models: [
        textModel({ futureField: { ignored: true } }),
        imageModel(),
        { modelKey: "bad-type", modelType: "hologram", executable: true },
        { modelKey: "bad:key", modelType: "image", executable: true },
        { modelKey: "server-audio-1", modelType: "MODEL_TYPE_AUDIO", executable: true }
      ]
    });
    const status = await loginAndRefresh(harness);
    expect(status.available).toBe(true);
    expect(status.modelCount).toBe(3);
    const ids = harness.providers[0]?.models.map((model) => model.providerModelId);
    expect(ids).toEqual(["server-text-1", "server-image-1", "server-audio-1"]);
    // 未知枚举形态被归一成合法类型（ProtoJSON 枚举字符串容错）。
    expect(harness.providers[0]?.models[2]?.modelType).toBe("audio");
    // 被跳过的条数进诊断，但不含模型内容。
    expect(harness.logEvents.some((event) => event.event === "remote-generation-catalog-degraded")).toBe(true);
  });

  it("uint64 目录修订号（ProtoJSON 字符串）被容错解析", async () => {
    const { fake, harness } = activateWithCatalog({ models: [textModel()], catalogRevision: 42 });
    const status = await loginAndRefresh(harness);
    expect(status.catalogRevision).toBeGreaterThan(0);
    // fake 用字符串回 catalogRevision；客户端能读到同一个值（进入 admission 的也是数字）。
    expect(fake.generation.catalog.catalogRevision).toBe(42);
    const registration = harness.providers[0];
    const prepared = await registration?.prepareInput?.({
      providerModelId: "server-text-1",
      modelType: "language",
      prompt: "p",
      parameters: {},
      references: [],
      canvasId: "canvas-remote-1",
      taskKey: "task-key-revision"
    });
    expect((prepared as { admission?: { catalogRevision?: number } }).admission?.catalogRevision).toBe(42);
  });
});

describe("服务端托管生成：提交 / 轮询 / 取消", () => {
  it("prepareInput 直接用画布资产的稳定键提交（不依赖任何地址）", async () => {
    const { harness } = activateWithCatalog({ models: [imageModel()] });
    await loginAndRefresh(harness);
    const registration = harness.providers[0];
    const prepared = await registration?.prepareInput?.({
      providerModelId: "server-image-1",
      modelType: "image",
      prompt: "画一只猫",
      parameters: { aspectRatio: "1:1" },
      references: [
        {
          role: "reference",
          mediaKind: "image",
          mediaType: "image/png",
          // `referenceHandling: "storage-key"`：Task 既不签地址也不上传字节，
          // 交过来的就是画布资产自己的稳定键。
          locator: `media://server/canvas-remote-1/media/generation-outputs/${hex("d")}.png`,
          assetId: "asset-1"
        }
      ],
      canvasId: "canvas-remote-1",
      taskKey: "task-key-2",
      runId: "run-2"
    });
    expect(prepared).toMatchObject({
      idempotencyKey: "task-key-2",
      canvasId: "canvas-remote-1",
      modelKey: "server-image-1",
      modelType: "image",
      prompt: "画一只猫",
      parameters: { aspectRatio: "1:1" },
      runId: "run-2"
    });
    // 提交的是**不透明 locator**：服务端据此读自己能读的对象，客户端不拼键。
    // 而这张画布的媒体已由归属路由放在服务端。
    expect(prepared!.inputs).toEqual([
      {
        assetId: "asset-1",
        role: "reference",
        mediaLocator: `media://server/canvas-remote-1/media/generation-outputs/${hex("d")}.png`,
        mediaType: "image/png",
        mediaKind: "image"
      }
    ]);
    const serialized = JSON.stringify(prepared);
    // 提交体里不允许出现任何地址：该 Provider 不吃 URL。
    expect(serialized).not.toContain("https://");
  });

  it("没有合法稳定键时按 media-not-found 收敛（地址不能当键用）", async () => {
    const { harness } = activateWithCatalog({ models: [imageModel()] });
    await loginAndRefresh(harness);
    const prepareInput = harness.providers[0]?.prepareInput;
    let caught: unknown;
    try {
      prepareInput?.({
        providerModelId: "server-image-1",
        modelType: "image",
        prompt: "画一只猫",
        parameters: {},
        references: [
          {
            role: "reference",
            mediaKind: "image",
            mediaType: "image/png",
            // 只有地址、没有合法稳定键：不能拿它当 storage_key。
            url: "https://signed.example.com/secret-token/image.png",
            assetId: "asset-1"
          }
        ],
        canvasId: "canvas-remote-1",
        taskKey: "task-key-signed"
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RemoteGenerationError);
    expect((caught as RemoteGenerationError).code).toBe("media-not-found");
  });

  it("缺幂等键或 locator 时抛稳定码（画布已可选）", async () => {
    const { harness } = activateWithCatalog({ models: [imageModel()] });
    await loginAndRefresh(harness);
    const prepareInput = harness.providers[0]?.prepareInput;
    const base = {
      providerModelId: "server-image-1",
      modelType: "image" as const,
      prompt: "p",
      parameters: {},
      references: [],
      canvasId: "canvas-remote-1",
      taskKey: "task-key-3"
    };

    for (const [patch, code] of [
      [{ taskKey: undefined }, "idempotency-key-missing"],
      [
        {
          references: [
            { role: "reference", mediaType: "image/png", url: "https://signed.example.com/x.png" }
          ]
        },
        "media-not-found"
      ]
    ] as const) {
      try {
        prepareInput?.({ ...base, ...patch } as never);
        throw new Error("expected prepareInput to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(RemoteGenerationError);
        expect((error as RemoteGenerationError).code).toBe(code);
      }
    }
  });

  it("提交 → 轮询 → 文本成功：SubmitTask 体正确、不携带令牌", async () => {
    const { fake, harness } = activateWithCatalog({
      models: [textModel()],
      taskResult: { kind: "text", text: "服务端生成的文本" }
    });
    await loginAndRefresh(harness);
    const registration = harness.providers[0];
    const prepared = await registration?.prepareInput?.({
      providerModelId: "server-text-1",
      modelType: "language",
      prompt: "写一句话",
      parameters: { temperature: 0.2 },
      references: [],
      canvasId: "canvas-remote-1",
      taskKey: "task-key-1",
      runId: "run-1"
    });

    const provider = pptaskOf(harness);
    const model = provider.languageModel("server-text-1");
    const started = await model.doStart!(prepared as never);
    expect(started.operation).toMatchObject({ taskId: "task-1", modelKey: "server-text-1" });

    // 提交体：稳定引用 + 受理版本；没有 URL、没有令牌。
    const submitted = fake.generation.submits[0];
    expect(submitted).toMatchObject({
      idempotencyKey: "task-key-1",
      canvasId: "canvas-remote-1",
      modelKey: "server-text-1",
      modelType: "language",
      prompt: "写一句话",
      parameters: { temperature: 0.2 },
      inputs: [],
      interaction: { id: "generic-model", version: 1 },
      runId: "run-1",
      admission: { catalogRevision: 1, schemaRevision: 7, configVersion: 3 }
    });
    const submitCall = fake.calls.find((call) => call.path.endsWith("/SubmitTask"));
    expect(submitCall?.authorization).toMatch(/^Bearer session-/);
    expect(submitCall?.path).not.toContain("token");
    expect(JSON.stringify(submitted)).not.toContain("https://");

    const first = await model.doStatus!({ operation: started.operation });
    expect(first).toMatchObject({ status: "pending", phase: "running", progress: 0.42 });
    const done = await model.doStatus!({ operation: started.operation });
    expect(done).toEqual({ status: "completed", content: [{ type: "text", text: "服务端生成的文本" }] });
  });

  it("媒体成功只返回稳定 storageKey + metadata，不返回地址", async () => {
    const media = {
      mediaKind: "image",
      storageKey: IMAGE_KEY,
      contentType: "image/png",
      size: "1024",
      checksum: "sha256-abc",
      durationSeconds: 2.5,
      poster: { storageKey: POSTER_KEY, contentType: "image/jpeg", size: "256" }
    };
    const { fake, harness } = activateWithCatalog({
      models: [imageModel()],
      taskResult: { kind: "media", media }
    });
    await loginAndRefresh(harness);
    const registration = harness.providers[0];
    const prepared = await registration?.prepareInput?.({
      providerModelId: "server-image-1",
      modelType: "image",
      prompt: "p",
      parameters: {},
      references: [],
      canvasId: "canvas-remote-1",
      taskKey: "task-key-media"
    });

    const provider = pptaskOf(harness);
    const model = provider.imageModel("server-image-1");
    const started = await model.doStart!(prepared as never);
    await model.doStatus!({ operation: started.operation });
    const done = await model.doStatus!({ operation: started.operation });
    expect(done.status).toBe("completed");
    const result = done as unknown as { media: Record<string, unknown> };
    expect(result.media).toEqual({
      storageKey: IMAGE_KEY,
      contentType: "image/png",
      size: 1024,
      checksum: "sha256-abc",
      durationSeconds: 2.5,
      poster: { storageKey: POSTER_KEY, contentType: "image/jpeg", size: 256 }
    });
    // 与 worker 的识别契约同形：可直接被 adopting 路径消费。
    expect(isGenerationStableMediaResult(done)).toBe(true);
    expect(JSON.stringify(done)).not.toContain("http");
    expect(fake.generation.submits).toHaveLength(1);
  });

  it("业务失败按稳定码收敛，不透传远端正文", async () => {
    const { fake, harness } = activateWithCatalog({
      models: [textModel()],
      taskResult: { kind: "failed", code: "catalog-changed" }
    });
    await loginAndRefresh(harness);
    const registration = harness.providers[0];
    const prepared = await registration?.prepareInput?.({
      providerModelId: "server-text-1",
      modelType: "language",
      prompt: "p",
      parameters: {},
      references: [],
      canvasId: "canvas-remote-1",
      taskKey: "task-key-fail"
    });
    const provider = pptaskOf(harness);
    const model = provider.languageModel("server-text-1");
    const started = await model.doStart!(prepared as never);
    await model.doStatus!({ operation: started.operation });
    await expect(model.doStatus!({ operation: started.operation })).rejects.toMatchObject({
      code: "catalog-changed",
      message: "模型目录已变化，请重新选择模型"
    });
    expect(fake.generation.tasks.size).toBe(1);
  });

  it("SubmitTask 稳定拒绝（FAILED）时从 GetTask 读回稳定码", async () => {
    const { harness } = activateWithCatalog({ models: [textModel()], rejectSubmitWith: "key-reused" });
    await loginAndRefresh(harness);
    const registration = harness.providers[0];
    const prepared = await registration?.prepareInput?.({
      providerModelId: "server-text-1",
      modelType: "language",
      prompt: "p",
      parameters: {},
      references: [],
      canvasId: "canvas-remote-1",
      taskKey: "task-key-reused"
    });
    const provider = pptaskOf(harness);
    await expect(provider.languageModel("server-text-1").doStart!(prepared as never)).rejects.toMatchObject({
      code: "key-reused",
      message: "同一提交键已用于不同的请求"
    });
  });

  it("取消调用 CancelTask（幂等），并如实声明 remote", async () => {
    const { fake, harness } = activateWithCatalog({ models: [textModel()] });
    await loginAndRefresh(harness);
    expect(harness.providers[0]?.models[0]?.cancel).toBe("remote");
    const registration = harness.providers[0];
    const prepared = await registration?.prepareInput?.({
      providerModelId: "server-text-1",
      modelType: "language",
      prompt: "p",
      parameters: {},
      references: [],
      canvasId: "canvas-remote-1",
      taskKey: "task-key-cancel"
    });
    const provider = pptaskOf(harness);
    const model = provider.languageModel("server-text-1");
    const started = await model.doStart!(prepared as never);
    await model.doCancel?.({ operation: started.operation });
    expect(fake.generation.cancels).toEqual(["task-1"]);
    expect(fake.generation.tasks.get("task-1")?.state).toBe("TASK_STATE_CANCELLED");
  });

  it("operation 只放可 JSON 化句柄（没有令牌/结果）", async () => {
    const { harness } = activateWithCatalog({ models: [textModel()] });
    await loginAndRefresh(harness);
    const registration = harness.providers[0];
    const prepared = await registration?.prepareInput?.({
      providerModelId: "server-text-1",
      modelType: "language",
      prompt: "p",
      parameters: {},
      references: [],
      canvasId: "canvas-remote-1",
      taskKey: "task-key-op"
    });
    const provider = pptaskOf(harness);
    const started = await provider.languageModel("server-text-1").doStart!(prepared as never);
    const serialized = JSON.stringify(started.operation);
    expect(serialized).not.toContain("session-");
    expect(serialized).not.toContain("token");
    expect(JSON.parse(serialized)).toMatchObject({ taskId: "task-1", modelKey: "server-text-1", modelType: "language" });
  });
});

describe("服务端托管生成：会话与刷新", () => {
  it("登出清空模型并翻转不可用，catalogRevision 前进，Provider 不重复注册", async () => {
    const { harness } = activateWithCatalog({ models: [textModel(), imageModel()] });
    const before = await loginAndRefresh(harness);
    expect(before.available).toBe(true);

    const logout = await harness.call(REMOTE_SERVER_LOGOUT_ROUTE);
    expect((logout.body as { ok: boolean }).ok).toBe(true);
    const after = statusOf(await harness.call(REMOTE_SERVER_GENERATION_REFRESH_ROUTE));
    expect(after).toMatchObject({ available: false, modelCount: 0 });
    expect(after.catalogRevision).toBeGreaterThan(before.catalogRevision);
    expect(harness.providers).toHaveLength(1);
    expect(harness.providers[0]?.models).toEqual([]);
    expect(harness.providers[0]?.available).toBe(false);
    expect(harness.counts.register).toBe(1);
  });

  it("手动刷新推进 catalogRevision，并能看到服务端新增的模型", async () => {
    const { fake, harness } = activateWithCatalog({ models: [textModel()] });
    const first = await loginAndRefresh(harness);
    const second = statusOf(await harness.call(REMOTE_SERVER_GENERATION_REFRESH_ROUTE));
    expect(second.catalogRevision).toBeGreaterThan(first.catalogRevision);
    expect(second.modelCount).toBe(1);

    // 服务端新增一个模型：只改目录（模拟运营上线），不需要客户端更新。
    fake.generation.catalog.models = [
      textModel(),
      { modelKey: "server-image-2", modelType: "image", executable: true }
    ];
    fake.generation.catalog.catalogRevision = 9;
    const third = statusOf(await harness.call(REMOTE_SERVER_GENERATION_REFRESH_ROUTE));
    expect(third.modelCount).toBe(2);
    expect(third.catalogRevision).toBeGreaterThan(second.catalogRevision);
    expect(harness.providers[0]?.models.map((model) => model.providerModelId)).toEqual([
      "server-text-1",
      "server-image-2"
    ]);
  });

  it("重复刷新不会重复注册同一个 providerId", async () => {
    const { harness } = activateWithCatalog({ models: [textModel()] });
    await loginAndRefresh(harness);
    await harness.call(REMOTE_SERVER_GENERATION_REFRESH_ROUTE);
    await harness.call(REMOTE_SERVER_GENERATION_REFRESH_ROUTE);
    expect(harness.counts.register).toBe(1);
    expect(harness.providers).toHaveLength(1);
  });

  it("已注册后远端暂时不可达时保留目录（一次抖动不该让模型消失）", async () => {
    const fake = createFakeServer({
      generation: { catalog: { models: [textModel()], catalogRevision: 1 } }
    });
    let online = true;
    const flaky: typeof globalThis.fetch = async (input, init) => {
      if (!online) throw new TypeError("fetch failed");
      return fake.fetch(input, init);
    };
    const harness = activate({ fake, fetchImpl: flaky });
    const before = await loginAndRefresh(harness);
    expect(before.available).toBe(true);

    online = false;
    const after = statusOf(await harness.call(REMOTE_SERVER_GENERATION_REFRESH_ROUTE));
    expect(after.available).toBe(true);
    expect(after.modelCount).toBe(1);
    expect(after.error).toBe("无法连接远端服务端");
    expect(harness.providers[0]?.available).toBe(true);
  });

  it("切换服务端地址（旧会话作废）后翻转休眠", async () => {
    const fake = createFakeServer({ generation: { catalog: { models: [textModel()] } } });
    let serverUrl: string | null = fake.serverUrl;
    const harness = activate({
      fake,
      deployment: () => ({ serverUrl, deviceToken: "device-token", keyPrefix: "" })
    });
    const before = await loginAndRefresh(harness);
    expect(before.available).toBe(true);

    serverUrl = "https://other.example.com";
    const after = statusOf(await harness.call(REMOTE_SERVER_GENERATION_REFRESH_ROUTE));
    expect(after.available).toBe(false);
    expect(after.modelCount).toBe(0);
  });

  it("未登录时刷新返回休眠状态，不发任何生成请求", async () => {
    const fake = createFakeServer({ generation: { catalog: { models: [textModel()] } } });
    const harness = activate({ fake });
    const status = statusOf(await harness.call(REMOTE_SERVER_GENERATION_REFRESH_ROUTE));
    expect(status).toMatchObject({ available: false, modelCount: 0, catalogRevision: 0 });
    expect(fake.calls.filter((call) => call.path.includes("woohaa.generation"))).toHaveLength(0);
  });
});
