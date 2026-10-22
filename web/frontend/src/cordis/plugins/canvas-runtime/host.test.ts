import { describe, expect, it, vi } from "vitest";
import { CanvasRuntimeHost } from "./host.js";
import type { BevyRuntime } from "./bevy-runtime.js";

function host(loadRuntime: () => Promise<BevyRuntime>, canvasId = "canvas-a") {
  return new CanvasRuntimeHost({ canvasId, loadRuntime, getSession: () => null,
    subscribeModelScenes: () => () => undefined, isModalActive: () => false, emit: () => undefined });
}

function runtime() {
  return { dispose: vi.fn() } as unknown as BevyRuntime;
}

describe("画布页面 renderer 生命周期", () => {
  it("同页重复 load 只创建一个 renderer，切换后释放旧实例并使用新实例", async () => {
    const first = runtime(); const second = runtime();
    const loadFirst = vi.fn(async () => first);
    const outgoing = host(loadFirst);
    const pending = outgoing.load();
    expect(outgoing.load()).toBe(pending);
    await pending;
    expect(loadFirst).toHaveBeenCalledOnce();
    outgoing.dispose(); outgoing.dispose();
    expect(first.dispose).toHaveBeenCalledOnce();
    const incoming = host(async () => second, "canvas-b");
    await incoming.load();
    expect(incoming.runtime()).toBe(second);
    expect(outgoing.runtime()).toBeNull();
    incoming.dispose();
    expect(second.dispose).toHaveBeenCalledOnce();
  });

  it("快速切换后迟到的加载结果会被释放，不发布 ready 或覆盖新页面", async () => {
    const oldRuntime = runtime(); const newRuntime = runtime();
    let finish!: (value: BevyRuntime) => void;
    const outgoing = host(() => new Promise(resolve => { finish = resolve; }));
    const pending = outgoing.load();
    outgoing.dispose();
    const changed = vi.fn(); outgoing.subscribe(changed);
    const incoming = host(async () => newRuntime, "canvas-b");
    await incoming.load();
    finish(oldRuntime); await pending;
    expect(oldRuntime.dispose).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
    expect(outgoing.runtime()).toBeNull();
    expect(incoming.runtime()).toBe(newRuntime);
    incoming.dispose();
  });

  it("退出后迟到的加载错误不发布告警，已释放页面不能再次装载", async () => {
    let fail!: (error: Error) => void;
    const loader = vi.fn(() => new Promise<BevyRuntime>((_resolve, reject) => { fail = reject; }));
    const outgoing = host(loader);
    const pending = outgoing.load();
    outgoing.dispose();
    const changed = vi.fn(); outgoing.subscribe(changed);
    fail(new Error("late load failure"));
    await expect(pending).rejects.toThrow("late load failure");
    expect(changed).not.toHaveBeenCalled();
    await expect(outgoing.load()).rejects.toThrow("disposed");
    expect(loader).toHaveBeenCalledOnce();
  });
});
