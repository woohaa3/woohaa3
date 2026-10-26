/**
 * 子进程入口与 ctx 代理（change: 2026-10-21-isolate-extension-host-process，任务 3.5）。
 *
 * 不真的 fork：用一对内存 IPC 通道把 `startChildHost` 与一个模拟宿主的 RPC 端点连起来，
 * 出网守卫换成空实现（守卫本身由 network-guard.test.ts 覆盖），入口模块由测试注入。
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXTENSION_HOST_METHODS,
  defineConfigSchema,
  type AnyHostExtensionPlugin,
  type ExtensionHostCapabilities,
  type ExtensionHostStartParams
} from "@woohaa3/contracts";
import { connectIpc, decodeLarge, encodeLarge, type IpcChannel, type RpcEndpoint } from "../rpc/index.js";
import { startChildHost } from "./main.js";

function channelPair(): [IpcChannel, IpcChannel] {
  const a = new EventEmitter() as EventEmitter & IpcChannel;
  const b = new EventEmitter() as EventEmitter & IpcChannel;
  const wire = (from: EventEmitter & IpcChannel, to: EventEmitter) => {
    (from as { send: IpcChannel["send"] }).send = (message, callback) => {
      queueMicrotask(() => to.emit("message", structuredClone(message)));
      callback?.(null);
      return true;
    };
  };
  wire(a, b);
  wire(b, a);
  return [a, b];
}

type Harness = {
  host: RpcEndpoint;
  notifications: Array<{ method: string; params: unknown }>;
  ready: Promise<{ ok: boolean; error?: { code: string; message: string } }>;
  stop: () => Promise<void>;
};

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop().catch(() => undefined);
});

const CONFIG = defineConfigSchema({
  apiKey: { kind: "string", secret: true, label: "Key", description: "k", reload: "hot" }
});

function launch(plugin: AnyHostExtensionPlugin, capabilities: Partial<ExtensionHostCapabilities> = {}, values: Record<string, unknown> = {}): Harness {
  const [hostSide, childSide] = channelPair();
  const host = connectIpc(hostSide);
  const notifications: Array<{ method: string; params: unknown }> = [];
  for (const method of Object.values(EXTENSION_HOST_METHODS)) {
    if (method.startsWith("ctx.") && method !== EXTENSION_HOST_METHODS.ctxAccessAssert) host.onNotification(method, (params) => notifications.push({ method, params }));
  }
  let resolveReady!: (value: { ok: boolean; error?: { code: string; message: string } }) => void;
  const ready = new Promise<{ ok: boolean; error?: { code: string; message: string } }>((resolve) => {
    resolveReady = resolve;
  });
  host.onNotification(EXTENSION_HOST_METHODS.ctxReady, (params) => resolveReady(params as never));
  const start: ExtensionHostStartParams = {
    instanceId: "i-1",
    entry: "/virtual/entry.mjs",
    factory: "createPlugin",
    kind: "provider",
    values,
    capabilities: { extensionId: plugin.name, routePrefixes: [`/api/extensions/${plugin.name}/`], storageNamespaces: [], network: [], ...capabilities }
  };
  host.handle(EXTENSION_HOST_METHODS.hello, () => start);
  let exited = false;
  startChildHost({
    channel: childSide,
    installGuards: () => undefined,
    importEntry: async () => ({ createPlugin: () => plugin }),
    exit: () => {
      exited = true;
    },
    healthIntervalMs: 60_000
  });
  const stop = async () => {
    if (exited || host.closed) return;
    await host.request(EXTENSION_HOST_METHODS.hostStop).catch(() => undefined);
    host.close();
  };
  stops.push(stop);
  return { host, notifications, ready, stop };
}

const basePlugin = (name: string, apply: AnyHostExtensionPlugin["apply"], extra: Partial<AnyHostExtensionPlugin> = {}): AnyHostExtensionPlugin => ({
  name,
  label: name,
  configPrefix: `providers.${name}`,
  inject: [],
  Config: CONFIG,
  apply,
  ...extra
});

describe("子进程 ctx 代理（3.1/3.2/3.5）", () => {
  it("未声明 storageNamespaces 时 ctx.storage 不存在；声明后只允许声明的命名空间", async () => {
    let seen: unknown = "unset";
    const h1 = launch(basePlugin("no-storage", (ctx) => {
      seen = (ctx as unknown as { get(name: string): unknown }).get("storage");
    }));
    await expect(h1.ready).resolves.toEqual({ ok: true });
    expect(seen).toBeUndefined();
    expect(h1.notifications.some((n) => n.method === EXTENSION_HOST_METHODS.ctxDiagnostic && (n.params as { service?: string }).service === "storage")).toBe(true);

    let denied: unknown;
    let putResult: unknown;
    const h2 = launch(basePlugin("with-storage", async (ctx) => {
      const storage = (ctx as unknown as { storage: { bucket(ns: string): { put(key: string, body: unknown): Promise<unknown> } } }).storage;
      try {
        storage.bucket("other");
      } catch (error) {
        denied = error;
      }
      putResult = await storage.bucket("cache").put("k", new Uint8Array([1, 2, 3]));
    }), { storageNamespaces: ["cache"] });
    h2.host.handle(EXTENSION_HOST_METHODS.storagePut, async (raw) => {
      const input = await decodeLarge<{ namespace: string; key: string; body: Uint8Array }>(h2.host, raw);
      return { namespace: input.namespace, key: input.key, size: input.body.byteLength };
    });
    await expect(h2.ready).resolves.toEqual({ ok: true });
    expect(denied).toMatchObject({ code: "permission-denied" });
    expect(putResult).toEqual({ namespace: "cache", key: "k", size: 3 });
  });

  it("越权路由前缀 permission-denied；未授权服务 ctx.canvas 抛 permission-denied、ctx.get 返回 undefined 并记诊断", async () => {
    const results: Record<string, unknown> = {};
    const h = launch(basePlugin("greedy", (ctx) => {
      const gateway = (ctx as unknown as { gateway: { route(order: number, handler: unknown, declaration?: unknown): unknown } }).gateway;
      try {
        gateway.route(10, () => false, { prefix: "/api/canvases/" });
      } catch (error) {
        results.route = error;
      }
      try {
        void (ctx as unknown as { canvas: unknown }).canvas;
      } catch (error) {
        results.canvas = error;
      }
      results.get = (ctx as unknown as { get(name: string): unknown }).get("canvas");
    }));
    await expect(h.ready).resolves.toEqual({ ok: true });
    expect(results.route).toMatchObject({ code: "permission-denied" });
    expect(results.canvas).toMatchObject({ code: "permission-denied" });
    expect(results.get).toBeUndefined();
    const diagnostics = h.notifications.filter((n) => n.method === EXTENSION_HOST_METHODS.ctxDiagnostic).map((n) => n.params as { service?: string });
    expect(diagnostics.some((d) => d.service === "canvas")).toBe(true);
  });

  it("apply 抛错 → ctx.ready { ok:false } 带错误码，子进程不自行退出", async () => {
    const h = launch(basePlugin("broken", () => {
      throw Object.assign(new Error("坏配置"), { code: "config-invalid" });
    }));
    const ready = await h.ready;
    expect(ready.ok).toBe(false);
    expect(ready.error?.message).toContain("坏配置");
    // 仍能应答心跳。
    await expect(h.host.request(EXTENSION_HOST_METHODS.ping)).resolves.toBe("pong");
  });
});

describe("Provider 分发（3.3）", () => {
  const providerPlugin = (calls: unknown[]) =>
    basePlugin("echo", (ctx) => {
      const model = {
        specificationVersion: "v3",
        maxImagesPerCall: 2,
        async doGenerate(options: { prompt: string; abortSignal?: AbortSignal }) {
          calls.push({ prompt: options.prompt, hasSignal: options.abortSignal instanceof AbortSignal });
          return { images: [new Uint8Array(3_000_000).fill(7)], warnings: [] };
        },
        async doStart(options: { abortSignal?: AbortSignal }, context?: { jobId: string }) {
          return await new Promise((resolve, reject) => {
            options.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            calls.push({ start: context?.jobId });
            void resolve;
          });
        }
      };
      ctx.effect(() =>
        (ctx as unknown as { generation: { register(provider: unknown): () => void } }).generation.register({
          extensionId: "echo",
          providerId: "echo",
          available: true,
          provider: { imageModel: () => model },
          models: [{ providerModelId: "m1", modelType: "image", label: "M1" }],
          prepareInput: (input: { prompt: string }) => ({ wrapped: input.prompt })
        })
      );
    });

  it("登记只上报可序列化部分与 modelInfo；doGenerate 往返（大结果走流）；成员函数调用", async () => {
    const calls: unknown[] = [];
    const h = launch(providerPlugin(calls));
    await expect(h.ready).resolves.toEqual({ ok: true });
    const registration = h.notifications.find((n) => n.method === EXTENSION_HOST_METHODS.ctxGenerationRegister)?.params as {
      providerId: string;
      members: string[];
      modelInfo: Record<string, { methods: string[]; maxImagesPerCall?: number }>;
    };
    expect(registration.providerId).toBe("echo");
    expect(registration.members).toEqual(["prepareInput"]);
    expect(registration.modelInfo["image:m1"]).toEqual({ methods: ["doGenerate", "doStart"], maxImagesPerCall: 2 });

    const raw = await h.host.request(EXTENSION_HOST_METHODS.providerModelCall, {
      providerId: "echo",
      modelType: "image",
      modelId: "m1",
      method: "doGenerate",
      options: { prompt: "hi" }
    });
    const result = await decodeLarge<{ images: Uint8Array[] }>(h.host, raw);
    expect(result.images[0]!.byteLength).toBe(3_000_000);
    expect(calls).toEqual([{ prompt: "hi", hasSignal: true }]);

    const prepared = await decodeLarge(h.host, await h.host.request(EXTENSION_HOST_METHODS.providerPrepareInput, encodeLarge(h.host, { providerId: "echo", input: { prompt: "p" } })));
    expect(prepared).toEqual({ wrapped: "p" });
    await expect(h.host.request(EXTENSION_HOST_METHODS.providerResolveModel, { providerId: "echo", input: {} })).rejects.toMatchObject({ code: "extension-host-unsupported" });
  });

  it("宿主取消 → 子进程 options.abortSignal abort；doStart 收到 context", async () => {
    const calls: unknown[] = [];
    const h = launch(providerPlugin(calls));
    await h.ready;
    const controller = new AbortController();
    const pending = h.host.request(
      EXTENSION_HOST_METHODS.providerModelCall,
      { providerId: "echo", modelType: "image", modelId: "m1", method: "doStart", options: {}, context: { jobId: "j-1" } },
      { signal: controller.signal, timeoutMs: 0 }
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toEqual([{ start: "j-1" }]);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "rpc-cancelled" });
  });
});

describe("gateway 分发（3.4）", () => {
  it("按 order 调处理器；首个返回 true 的生效，响应头与响应体走流；全部 false → handled:false；授权经宿主", async () => {
    const h = launch(basePlugin("router", (ctx) => {
      const runtime = ctx as unknown as {
        gateway: { route(order: number, handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => Promise<boolean> | boolean): void };
        access: { authenticator(req: unknown): Promise<unknown>; accessEnforcer: { assertAction(principal: unknown, action: string): Promise<void> } };
      };
      runtime.gateway.route(20, () => false);
      runtime.gateway.route(10, async (req, res) => {
        if (!req.url?.startsWith("/api/extensions/router/echo")) return false;
        const principal = await runtime.access.authenticator(req);
        await runtime.access.accessEnforcer.assertAction(principal, "models.manage");
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
        res.writeHead(201, { "content-type": "text/plain" });
        res.end(`echo:${Buffer.concat(chunks).toString()}`);
        return true;
      });
    }));
    const asserted: unknown[] = [];
    h.host.handle(EXTENSION_HOST_METHODS.ctxAccessAssert, (params) => {
      asserted.push(params);
      return null;
    });
    await expect(h.ready).resolves.toEqual({ ok: true });
    const routes = h.notifications.filter((n) => n.method === EXTENSION_HOST_METHODS.ctxGatewayRoute).map((n) => (n.params as { prefix: string }).prefix);
    expect(routes).toEqual(["/api/extensions/router/"]);

    const body = h.host.streams.open("gateway.body");
    void body.write(new TextEncoder().encode("ping")).then(() => body.end());
    const response = (await h.host.request(EXTENSION_HOST_METHODS.gatewayRequest, {
      requestId: "r-1",
      routeId: "/api/extensions/router/",
      method: "POST",
      url: "/api/extensions/router/echo",
      headers: {},
      principal: { subject: "u-1" },
      bodyStreamId: body.streamId
    })) as { handled: boolean; status: number; headers: Record<string, string>; bodyStreamId: string };
    expect(response).toMatchObject({ handled: true, status: 201, headers: { "content-type": "text/plain" } });
    const parts: Buffer[] = [];
    for await (const chunk of h.host.streams.take(response.bodyStreamId)) parts.push(Buffer.from(chunk));
    expect(Buffer.concat(parts).toString()).toBe("echo:ping");
    expect(asserted).toEqual([{ requestId: "r-1", action: "models.manage" }]);

    const miss = await h.host.request(EXTENSION_HOST_METHODS.gatewayRequest, {
      requestId: "r-2",
      routeId: "/api/extensions/router/",
      method: "GET",
      url: "/api/extensions/router/other",
      headers: {}
    });
    expect(miss).toEqual({ handled: false });
  });
});
