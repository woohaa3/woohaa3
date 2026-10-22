// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createRuntimeRealm } from "./runtime-realm.js";
import type { BevyModule } from "./bevy-runtime-types.js";
import { installDeviceRecovery } from "./device-recovery.js";

type Handoff = { ready(module: BevyModule): void; fault(reason: string): void };
const registry = () => (globalThis as typeof globalThis & { __rendererRealms: Map<string, Handoff> }).__rendererRealms;
afterEach(() => { document.body.innerHTML = ""; registry()?.clear(); vi.useRealTimers(); });
function surface() {
  const host = document.createElement("div"); const canvas = document.createElement("canvas");
  canvas.id = "bevy-canvas"; host.append(canvas); document.body.append(host); return { host, canvas };
}

it("真正移除 realm 并释放交接 token，旧故障回调无效；宿主移动可检测", async () => {
  const { canvas } = surface(); const fault = vi.fn();
  const pending = createRuntimeRealm(globalThis, fault);
  const handoff = [...registry().values()][0]!;
  const raw = {} as BevyModule; handoff.ready(raw);
  const realm = await pending;
  expect(realm.module).toBe(raw); expect(realm.connected()).toBe(true);
  document.body.append(canvas); expect(realm.connected()).toBe(false);
  realm.dispose(); expect(document.querySelector("iframe")).toBeNull(); expect(registry().size).toBe(0);
  handoff.fault("late-error"); expect(fault).not.toHaveBeenCalled();
});

it("首个 scene 绘制前 iframe 保持透明，reveal 后淡入并解除 curtain", async () => {
  const { host } = surface();
  const pending = createRuntimeRealm(globalThis, vi.fn());
  [...registry().values()][0]!.ready({} as BevyModule);
  const realm = await pending;
  const iframe = document.querySelector("iframe")!;
  expect(iframe.style.opacity).toBe("0");
  expect(host.dataset.canvasPresented).toBeUndefined();
  realm.reveal();
  expect(iframe.style.opacity).toBe("1");
  expect(host.dataset.canvasPresented).toBe("true");
  realm.dispose();
  expect(host.dataset.canvasPresented).toBeUndefined();
});

it("装载失败/超时释放 iframe 和回调，不遗留旧实例", async () => {
  vi.useFakeTimers(); surface();
  const pending = createRuntimeRealm(globalThis, vi.fn());
  const result = expect(pending).rejects.toThrow("装载超时");
  await vi.advanceTimersByTimeAsync(30000); await result;
  expect(registry().size).toBe(0); expect(document.querySelector("iframe")).toBeNull();
});

it("切换取消尚未装载的 realm，立即释放旧 iframe，迟到回调不影响新 realm", async () => {
  vi.useFakeTimers();
  const { host } = surface(); const fault = vi.fn(); const abort = new AbortController();
  const pending = createRuntimeRealm(globalThis, fault, abort.signal);
  const oldHandoff = [...registry().values()][0]!;
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  abort.abort(); await rejected;
  expect(registry().size).toBe(0); expect(host.querySelector("iframe")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  const next = createRuntimeRealm(globalThis, fault);
  const raw = {} as BevyModule;
  oldHandoff.ready({} as BevyModule); oldHandoff.fault("late-error");
  [...registry().values()][0]!.ready(raw);
  const realm = await next;
  expect(realm.module).toBe(raw); expect(realm.connected()).toBe(true);
  expect(fault).not.toHaveBeenCalled();
  realm.dispose();
});

it("宿主注入原生引导时走桌面 realm，不再创建 WASM iframe", async () => {
  surface();
  (globalThis as typeof globalThis & { __WOOHAA_NATIVE__?: unknown }).__WOOHAA_NATIVE__ = { protocol: "mismatch", token: "t" };
  try {
    // 协议不匹配在原生分支内失败，证明没有落到 iframe 分支。
    await expect(createRuntimeRealm(globalThis, vi.fn())).rejects.toThrow("桌面画布协议不匹配");
    expect(document.querySelector("iframe")).toBeNull();
  } finally {
    delete (globalThis as typeof globalThis & { __WOOHAA_NATIVE__?: unknown }).__WOOHAA_NATIVE__;
  }
});

it("context lost 上报 owner 并阻止默认行为，销毁后不再上报", () => {
  const { canvas } = surface(); const fault = vi.fn();
  const cleanup = installDeviceRecovery(canvas, fault);
  const event = new Event("webglcontextlost", { cancelable: true }); canvas.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true); expect(fault).toHaveBeenCalledOnce();
  cleanup(); canvas.dispatchEvent(new Event("webglcontextlost")); expect(fault).toHaveBeenCalledOnce();
});


it("桌面桥接存在时选择原生入口，协议错误不回退 WASM", async () => {
  surface();
  const target = Object.create(globalThis) as typeof globalThis & { __WOOHAA_NATIVE__: unknown };
  target.__WOOHAA_NATIVE__ = { protocol: "invalid", token: "test" };
  await expect(createRuntimeRealm(target, vi.fn())).rejects.toThrow("桌面画布协议不匹配");
  expect(document.querySelector("iframe")).toBeNull();
});
