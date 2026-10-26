/**
 * Extension Host 服务（任务 7.5）：真实 fork fixture-crashy，验证崩溃后果、自动重启、心跳判死与熔断。
 * 退避用真实时钟会太慢：通过 supervisor 常量无法注入，因此本文件只覆盖「崩溃 → 后果 → 第一次重启」与
 * 「心跳超时判死只处理一次」；熔断时序由 supervisor.test.ts 的虚拟时钟覆盖。
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GenerationProvider, HostGenerationService } from "@woohaa3/contracts";
import type { PptaskProvider } from "@sdppp/pptask";
import { CHILD_ENTRY, buildFixture } from "./isolated-provider.test-support.js";
import { createExtensionHostManager } from "./manager.js";
import { createExtensionHostService, type ExtensionHostService } from "./service.js";

function registry(): HostGenerationService & { map: Map<string, GenerationProvider> } {
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
let service: ExtensionHostService;
let generation: ReturnType<typeof registry>;
let base: string;
let server: http.Server;
const events: Record<string, unknown>[] = [];
const quarantines: string[] = [];

beforeAll(async () => {
  if (!fs.existsSync(CHILD_ENTRY)) throw new Error(`缺少 ${CHILD_ENTRY}`);
  fixture = buildFixture("fixture-crashy");
  generation = registry();
  const manager = createExtensionHostManager({
    childEntry: CHILD_ENTRY,
    log: (event) => events.push(event),
    settings: () => ({ maxOldSpaceMb: 96, maxProcesses: 4 }),
    heartbeatIntervalMs: 200,
    heartbeatTimeoutMs: 800
  });
  service = createExtensionHostService({
    descriptors: [fixture.descriptor],
    manager,
    generation,
    log: (event) => events.push(event),
    activationTimeoutMs: () => 15_000,
    disposeTimeoutMs: () => 2_000,
    drainTimeoutMs: () => 1_000,
    onQuarantine: (id) => void quarantines.push(id)
  });
  const [entry] = service.plugins();
  server = http.createServer((req, res) => {
    void entry!.forwarder.handle(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("downstream");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // 用代理插件的 apply 激活（与装载器同路径）。
  const effects: Array<() => unknown> = [];
  await entry!.plugin.apply({ effect: (fn: () => () => unknown) => effects.push(fn()) } as never, { crashOnActivate: false } as never);
}, 60_000);

afterAll(async () => {
  await service?.stopAll();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fixture?.cleanup();
});

const ping = async () => (await fetch(`${base}/api/extensions/fixture-crashy/ping`, { method: "POST" })).status;

describe("崩溃后果与自动重启（真实子进程）", () => {
  it("扩展主动 exit：Provider 立即撤注册、路由 503、在途生成以 extension-crashed 失败；退避后自动恢复", async () => {
    expect(await ping()).toBe(200);
    expect(generation.map.has("fixture-crashy")).toBe(true);
    const pid = service.view("fixture-crashy")!.pid;
    const provider = generation.resolve("fixture-crashy")!.provider as PptaskProvider;
    const inflight = Promise.resolve(provider.languageModel("crash-exit").doGenerate({ prompt: [] } as never)).then(
      () => "ok",
      (error: { code?: string }) => error.code
    );
    expect(await inflight).toBe("extension-crashed");
    // IPC 断开（在途失败）与进程 exit（撤镜像）是两个事件，先后到达。
    await expect.poll(() => generation.map.has("fixture-crashy"), { timeout: 2000, interval: 10 }).toBe(false);
    expect(await ping()).toBe(503);
    expect(service.view("fixture-crashy")!.supervisor).toMatchObject({ state: "restarting", crashCount: 1 });
    // 1s ±20% 后自动重启：Provider 回到注册表，新 pid。
    await expect.poll(() => generation.map.has("fixture-crashy"), { timeout: 5000, interval: 100 }).toBe(true);
    expect(service.view("fixture-crashy")!.pid).not.toBe(pid);
    expect(await ping()).toBe(200);
  }, 30_000);

  it("同步死循环：心跳超时判死（只处理一次），宿主事件循环不受影响", async () => {
    const before = events.filter((event) => event.event === "extension-host-crashed").length;
    const started = Date.now();
    void fetch(`${base}/api/extensions/fixture-crashy/hang`, { method: "POST" }).catch(() => undefined);
    // 宿主侧计时器照常运转（证明死循环发生在子进程）。
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(Date.now() - started).toBeLessThan(1000);
    await expect.poll(() => events.filter((event) => event.event === "extension-host-crashed").length, { timeout: 5000 }).toBe(before + 1);
    const crashed = events.filter((event) => event.event === "extension-host-crashed").at(-1)!;
    expect(crashed.reason).toBe("heartbeat-timeout");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(events.filter((event) => event.event === "extension-host-crashed").length).toBe(before + 1);
    await expect.poll(() => generation.map.has("fixture-crashy"), { timeout: 8000, interval: 100 }).toBe(true);
  }, 30_000);

  it("swap 到同目录为 no-op；未装配扩展抛 MARKETPLACE_NOT_INSTALLED", async () => {
    expect(await service.swap("fixture-crashy", fixture.dir)).toEqual({ swapped: false });
    await expect(service.swap("nope", "/x")).rejects.toMatchObject({ code: "MARKETPLACE_NOT_INSTALLED" });
    expect(service.isolated("fixture-crashy")).toBe(true);
    expect(service.isolated("nope")).toBe(false);
  });

  it("remove 停止子进程并撤镜像（幂等）", async () => {
    await service.remove("fixture-crashy");
    await service.remove("fixture-crashy");
    expect(generation.map.has("fixture-crashy")).toBe(false);
    expect(service.isolated("fixture-crashy")).toBe(false);
    expect(await ping()).toBe(503);
  }, 15_000);
});

describe("运行期装配（首次安装热装）", () => {
  it("add：新描述得到代理插件与挂好的路由；同 id 重复 add 抛 extension-exists；remove 后可重新 add", async () => {
    const echo = buildFixture("fixture-echo-provider");
    const mounted: number[] = [];
    const unmounted: number[] = [];
    const runtime = createExtensionHostService({
      descriptors: [],
      manager: createExtensionHostManager({ childEntry: CHILD_ENTRY, log: () => undefined, settings: () => ({ maxOldSpaceMb: 96, maxProcesses: 2 }) }),
      generation,
      log: () => undefined,
      activationTimeoutMs: () => 15_000,
      disposeTimeoutMs: () => 2_000,
      drainTimeoutMs: () => 1_000,
      mountRoute: (entry) => {
        mounted.push(entry.order);
        return () => void unmounted.push(entry.order);
      }
    });
    try {
      expect(runtime.isolated("fixture-echo-provider")).toBe(false);
      const { plugin, order } = runtime.add(echo.descriptor);
      expect(plugin.name).toBe("fixture-echo-provider");
      expect(mounted).toEqual([order]);
      expect(runtime.isolated("fixture-echo-provider")).toBe(true);
      expect(() => runtime.add(echo.descriptor)).toThrow(expect.objectContaining({ code: "extension-exists" }));
      await plugin.apply({ effect: () => undefined } as never, { greeting: "rt", delayMs: 0 } as never);
      expect(generation.map.has("fixture-echo")).toBe(true);
      await runtime.remove("fixture-echo-provider");
      expect(unmounted).toEqual([order]);
      expect(generation.map.has("fixture-echo")).toBe(false);
      expect(runtime.isolated("fixture-echo-provider")).toBe(false);
      expect(() => runtime.add(echo.descriptor)).not.toThrow();
    } finally {
      await runtime.stopAll();
      echo.cleanup();
    }
  }, 30_000);
});
