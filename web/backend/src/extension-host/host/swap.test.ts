/**
 * 蓝绿切换（任务 8.3），真实 fork 两个版本目录。需要先构建 `dist/extension-host-child.js`。
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GenerationProvider, HostGenerationService } from "@woohaa3/contracts";
import type { PptaskProvider } from "@sdppp/pptask";
import { createIsolatedController, type IsolatedController } from "./controller.js";
import { capabilitiesFor } from "./descriptor.js";
import { createGatewayForwarder } from "./gateway-forward.js";
import { CHILD_ENTRY, buildFixture } from "./isolated-provider.test-support.js";
import { createExtensionHostManager, type ExtensionHostManager } from "./manager.js";
import { createExtensionSwapper, ExtensionSwapError, type ExtensionSwapper } from "./swap.js";

function registry(): HostGenerationService & { map: Map<string, GenerationProvider>; gaps: number } {
  const map = new Map<string, GenerationProvider>();
  const state = {
    map,
    gaps: 0,
    register(provider: GenerationProvider) {
      // 与宿主注册表一致：重复 providerId 直接拒绝。
      if (map.has(provider.providerId)) throw new Error(`生成 Provider 已注册：${provider.providerId}`);
      map.set(provider.providerId, provider);
      return () => {
        if (map.get(provider.providerId) === provider) map.delete(provider.providerId);
      };
    },
    unregister: (providerId: string) => {
      map.delete(providerId);
      state.gaps += 1;
    },
    registerConversion: () => () => undefined,
    list: () => [...map.values()],
    resolve: (providerId: string) => map.get(providerId),
    conversions: () => []
  };
  return state;
}

let v1: ReturnType<typeof buildFixture>;
let v2: ReturnType<typeof buildFixture>;
let broken: ReturnType<typeof buildFixture>;
let manager: ExtensionHostManager;
let controller: IsolatedController;
let swapper: ExtensionSwapper;
let generation: ReturnType<typeof registry>;
let drainTimeoutMs = 5_000;

beforeAll(() => {
  if (!fs.existsSync(CHILD_ENTRY)) throw new Error(`缺少 ${CHILD_ENTRY}`);
  v1 = buildFixture("fixture-echo-provider");
  v2 = buildFixture("fixture-echo-provider");
  broken = buildFixture("fixture-echo-provider");
  fs.writeFileSync(path.join(broken.dir, "backend-dist/entry.mjs"), 'throw new Error("broken version");\n');
  manager = createExtensionHostManager({ childEntry: CHILD_ENTRY, log: () => undefined, settings: () => ({ maxOldSpaceMb: 128, maxProcesses: 6 }) });
  generation = registry();
  const forwarder = createGatewayForwarder({ extensionId: v1.descriptor.extensionId, target: () => controller.target(), reservedPrefixes: capabilitiesFor(v1.descriptor).routePrefixes });
  controller = createIsolatedController({
    descriptor: v1.descriptor,
    manager,
    generation,
    forwarder,
    log: () => undefined,
    activationTimeoutMs: () => 15_000,
    disposeTimeoutMs: () => 3_000
  });
  swapper = createExtensionSwapper({ controller, log: () => undefined, drainTimeoutMs: () => drainTimeoutMs, drainPollMs: 20 });
}, 120_000);

afterAll(async () => {
  await controller?.deactivate();
  await manager?.stopAll(2000);
  for (const fixture of [v1, v2, broken]) fixture?.cleanup();
});

const textPid = async () => {
  const provider = generation.resolve("fixture-echo")!.provider as PptaskProvider;
  const result = await provider.languageModel("echo-text").doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }] } as never);
  return (result.providerMetadata?.["fixture-echo"] as { pid: number }).pid;
};

describe("蓝绿切换", () => {
  it("升级期间持续请求无空窗：注册表始终有 Provider、每个请求都成功，切换后请求落到新进程", async () => {
    await controller.activate({ greeting: "v1", delayMs: 10 });
    const bluePid = controller.active()!.instance.pid;
    const gapsBefore = generation.gaps;
    let stop = false;
    let failures = 0;
    let missing = 0;
    let served = 0;
    const load = (async () => {
      while (!stop) {
        if (!generation.resolve("fixture-echo")) missing += 1;
        try {
          await textPid();
          served += 1;
        } catch {
          failures += 1;
        }
      }
    })();
    const result = await swapper.swap(v2.dir);
    await new Promise((resolve) => setTimeout(resolve, 200));
    stop = true;
    await load;
    expect(result.outcome).toBe("swapped");
    expect(served).toBeGreaterThan(5);
    expect(failures).toBe(0);
    expect(missing).toBe(0);
    // 同 providerId 用替换语义：切换没有 unregister 空窗。
    expect(generation.gaps).toBe(gapsBefore);
    const greenPid = controller.active()!.instance.pid;
    expect(greenPid).not.toBe(bluePid);
    expect(await textPid()).toBe(greenPid);
    expect(controller.directory()).toBe(v2.dir);
    // 蓝实例排空后停止。
    await expect.poll(() => swapper.draining(), { timeout: 5000 }).toBe(0);
    expect(() => process.kill(bluePid!, 0)).toThrow();
  }, 60_000);

  it("同版本目录 swap 为 no-op", async () => {
    const pid = controller.active()!.instance.pid;
    expect(await swapper.swap(v2.dir)).toEqual({ outcome: "noop" });
    expect(controller.active()!.instance.pid).toBe(pid);
  });

  it("绿激活失败：抛 MARKETPLACE_SWAP_FAILED，蓝不受影响继续服务", async () => {
    const bluePid = controller.active()!.instance.pid;
    const failure = await swapper.swap(broken.dir).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExtensionSwapError);
    expect((failure as ExtensionSwapError).code).toBe("MARKETPLACE_SWAP_FAILED");
    expect(controller.active()!.instance.pid).toBe(bluePid);
    expect(controller.directory()).toBe(v2.dir);
    expect(await textPid()).toBe(bluePid);
  }, 60_000);

  it("回滚也是一次 swap：切回上一版本目录，请求落到新的进程", async () => {
    const before = controller.active()!.instance.pid;
    expect((await swapper.swap(v1.dir)).outcome).toBe("swapped");
    expect(controller.directory()).toBe(v1.dir);
    expect(await textPid()).not.toBe(before);
    await expect.poll(() => swapper.draining(), { timeout: 5000 }).toBe(0);
  }, 60_000);

  it("没有活跃实例（停用中）：只改下一次激活的目录，不起进程", async () => {
    await controller.deactivate();
    const before = manager.size();
    expect(await swapper.swap(v2.dir)).toEqual({ outcome: "activated" });
    expect(manager.size()).toBe(before);
    expect(controller.directory()).toBe(v2.dir);
  });
});

describe("排空超时（替身控制器）", () => {
  it("蓝在途调用不清零：超时后以 extension-replaced 关闭并停止蓝", async () => {
    const { createRpcPair } = await import("./rpc-pair.test-support.js");
    const blue = createRpcPair();
    const green = createRpcPair();
    blue.child.handle("slow", () => new Promise(() => undefined));
    const stuck = blue.host.request("slow", undefined, { timeoutMs: 0 }).then(() => "ok", (error: { code?: string }) => error.code);
    const stopped: string[] = [];
    const make = (name: string, rpc: typeof blue.host, directory: string) => ({ instance: { instanceId: name, stop: async () => undefined }, binding: { rpc }, directory });
    let active: ReturnType<typeof make> | null = make("blue", blue.host, "/v1");
    const fake = {
      extensionId: "fx",
      active: () => active,
      directory: () => active?.directory ?? "/v1",
      prepare: async (directory: string) => make("green", green.host, directory),
      commit: (candidate: ReturnType<typeof make>) => {
        const previous = active;
        active = candidate;
        return previous;
      },
      stopInstance: async (target: ReturnType<typeof make>) => void stopped.push(target.instance.instanceId),
      retarget: () => undefined,
      wanted: () => true
    } as unknown as IsolatedController;
    const swap = createExtensionSwapper({ controller: fake, log: () => undefined, drainTimeoutMs: () => 60, drainPollMs: 10 });
    expect((await swap.swap("/v2")).outcome).toBe("swapped");
    expect(swap.draining()).toBe(1);
    await expect.poll(() => stopped, { timeout: 2000 }).toEqual(["blue"]);
    expect(await stuck).toBe("extension-replaced");
    expect(swap.draining()).toBe(0);
  });

  it("同一扩展的 swap 串行执行", async () => {
    const order: string[] = [];
    let active: { directory: string } | null = { directory: "/v1" };
    const fake = {
      extensionId: "fx",
      active: () => active,
      directory: () => active!.directory,
      prepare: async (directory: string) => {
        order.push(`prepare:${directory}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { directory, instance: { instanceId: directory }, binding: { rpc: { closed: true, inFlight: () => 0, close: () => undefined } } };
      },
      commit: (candidate: { directory: string }) => {
        order.push(`commit:${candidate.directory}`);
        const previous = active;
        active = candidate;
        return previous ? null : null;
      },
      stopInstance: async () => undefined,
      retarget: () => undefined,
      wanted: () => true
    } as unknown as IsolatedController;
    const swap = createExtensionSwapper({ controller: fake, log: () => undefined, drainTimeoutMs: () => 10 });
    await Promise.all([swap.swap("/v2"), swap.swap("/v3")]);
    expect(order).toEqual(["prepare:/v2", "commit:/v2", "prepare:/v3", "commit:/v3"]);
  });
});

describe("崩溃后换版本（观察期回滚）", () => {
  it("应当运行但没有活跃实例：swap 直接激活新目录", async () => {
    let active: { directory: string } | null = null;
    const activated: string[] = [];
    const fake = {
      extensionId: "fx",
      active: () => active,
      directory: () => "/v2",
      values: () => ({ a: 1 }),
      wanted: () => true,
      activate: async (_values: unknown, directory: string) => {
        activated.push(directory);
        active = { directory };
      },
      retarget: () => {
        throw new Error("不应只改指向");
      }
    } as unknown as IsolatedController;
    const swap = createExtensionSwapper({ controller: fake, log: () => undefined, drainTimeoutMs: () => 10 });
    expect(await swap.swap("/v1")).toEqual({ outcome: "activated" });
    expect(activated).toEqual(["/v1"]);
  });
});
