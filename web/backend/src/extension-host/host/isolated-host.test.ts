/**
 * 宿主侧代理插件 + 真实子进程（任务 4.5）：fork 真实 `dist/extension-host-child.js`，装 fixture-echo-provider。
 * 需要先 `pnpm -C web/backend run build:extension-host-child`。
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GenerationProvider, HostGenerationService } from "@woohaa3/contracts";
import type { PptaskProvider } from "@sdppp/pptask";
import { createIsolatedController, type IsolatedController } from "./controller.js";
import { capabilitiesFor } from "./descriptor.js";
import { createGatewayForwarder } from "./gateway-forward.js";
import { CHILD_ENTRY, buildFixture } from "./isolated-provider.test-support.js";
import { createExtensionHostManager, type ExtensionHostManager } from "./manager.js";
import { createProxyPlugin } from "./proxy-plugin.js";

function createRegistry(): HostGenerationService & { map: Map<string, GenerationProvider> } {
  const map = new Map<string, GenerationProvider>();
  return {
    map,
    register(provider) {
      if (map.has(provider.providerId)) throw new Error(`生成 Provider 已注册：${provider.providerId}`);
      map.set(provider.providerId, provider);
      return () => {
        if (map.get(provider.providerId) === provider) map.delete(provider.providerId);
      };
    },
    unregister: (providerId) => void map.delete(providerId),
    registerConversion: () => () => undefined,
    list: () => [...map.values()],
    resolve: (providerId) => map.get(providerId),
    conversions: () => []
  };
}

let fixture: ReturnType<typeof buildFixture>;
let manager: ExtensionHostManager;
let controller: IsolatedController;
let registry: ReturnType<typeof createRegistry>;
let base: string;
let server: http.Server;
const events: Record<string, unknown>[] = [];

beforeAll(async () => {
  if (!fs.existsSync(CHILD_ENTRY)) throw new Error(`缺少 ${CHILD_ENTRY}：先运行 pnpm -C web/backend run build:extension-host-child`);
  fixture = buildFixture("fixture-echo-provider");
  manager = createExtensionHostManager({ childEntry: CHILD_ENTRY, log: (event) => events.push(event), settings: () => ({ maxOldSpaceMb: 128, maxProcesses: 4 }) });
  registry = createRegistry();
  const forwarder = createGatewayForwarder({
    extensionId: fixture.descriptor.extensionId,
    target: () => controller.target(),
    reservedPrefixes: capabilitiesFor(fixture.descriptor).routePrefixes
  });
  controller = createIsolatedController({
    descriptor: fixture.descriptor,
    manager,
    generation: registry,
    forwarder,
    log: (event) => events.push(event),
    activationTimeoutMs: () => 15_000,
    disposeTimeoutMs: () => 3_000
  });
  server = http.createServer((req, res) => {
    void forwarder.handle(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("downstream");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await controller?.deactivate();
  await manager?.stopAll(2000);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fixture?.cleanup();
});

describe("代理插件 + 真实子进程", () => {
  it("代理插件元数据来自静态描述；apply 起子进程并镜像 Provider 与路由", async () => {
    const plugin = createProxyPlugin({ controller });
    expect(plugin.name).toBe("fixture-echo-provider");
    expect(plugin.configPrefix).toBe("providers.fixture-echo");
    expect(Object.keys(plugin.Config.fields)).toEqual(["greeting", "delayMs"]);
    expect(plugin.modelRefresh?.path).toBe("/api/extensions/fixture-echo-provider/refresh");
    await controller.activate({ greeting: "hi", delayMs: 50 });
    const pid = controller.active()!.instance.pid;
    expect(pid).toBeTypeOf("number");
    expect(pid).not.toBe(process.pid);
    expect(registry.map.has("fixture-echo")).toBe(true);
  }, 30_000);

  it("Provider 桩往返：同步文本模型与 jobs 驱动的异步图片模型都在子进程执行", async () => {
    const provider = registry.resolve("fixture-echo")!;
    const pptask = provider.provider as PptaskProvider;
    const text = await pptask.languageModel("echo-text").doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }] } as never);
    expect(text.content[0]).toMatchObject({ type: "text", text: "hi: ping" });
    const childPid = (text.providerMetadata?.["fixture-echo"] as { pid?: number } | undefined)?.pid;
    expect(childPid).toBe(controller.active()!.instance.pid);
    const handle = await pptask.jobs.start({ model: pptask.imageModel("echo-image"), input: { prompt: "cat", n: 1 } });
    const result = (await handle.wait()) as { images: unknown[] };
    expect(result.images.length).toBeGreaterThan(0);
  }, 30_000);

  it("gateway 转发到子进程的模型刷新路由；越权路径不在路由表", async () => {
    const response = await fetch(`${base}/api/extensions/fixture-echo-provider/refresh`, { method: "POST" });
    expect(response.status).toBeLessThan(500);
    expect(await (await fetch(`${base}/api/other`)).text()).toBe("downstream");
  }, 30_000);

  it("杀子进程：Provider 立即撤注册、路由 503、在途调用以 extension-crashed 失败", async () => {
    let crashed = false;
    const pptask = registry.resolve("fixture-echo")!.provider as PptaskProvider;
    const handle = await pptask.jobs.start({ model: pptask.imageModel("echo-image"), input: { prompt: "slow", n: 1 } });
    const waited = handle.wait().then(() => "resolved", (error: { code?: string; message?: string }) => error.code ?? error.message ?? "rejected");
    const active = controller.active()!;
    active.instance.exited.then(() => {
      crashed = true;
    });
    process.kill(active.instance.pid!, "SIGKILL");
    await expect.poll(() => crashed, { timeout: 5000 }).toBe(true);
    expect(registry.map.has("fixture-echo")).toBe(false);
    expect(controller.active()).toBeNull();
    const route = await fetch(`${base}/api/extensions/fixture-echo-provider/refresh`, { method: "POST" });
    expect(route.status).toBe(503);
    expect(await route.json()).toMatchObject({ code: "extension-unavailable", extensionId: "fixture-echo-provider" });
    expect(await waited).not.toBe("resolved");
  }, 30_000);
});
