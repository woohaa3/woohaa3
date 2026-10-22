import { describe, expect, it, vi } from "vitest";
import { startFrameMonitor, type FrameSnapshot } from "./monitor.js";

function harness(drawCalls3d?: number) {
  let now = 0;
  let nextId = 0;
  const pending = new Map<number, () => void>();
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const source = {
    performance: { now: () => now },
    setInterval: (callback: TimerHandler) => { pending.set(++nextId, callback as () => void); return nextId; },
    clearInterval: (id?: number) => { if (id !== undefined) pending.delete(id); },
    document: {
      hidden: false,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => { if (listener) listeners.add(listener); },
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => { if (listener) listeners.delete(listener); }
    }
  };
  let counters: FrameSnapshot | null = { instance: {}, generation: 1, renders: 100, updates: 100, drawCalls3d };
  const publish = vi.fn();
  const read = vi.fn(() => counters);
  const stop = startFrameMonitor(source, read, publish);
  return {
    source, pending, listeners, publish, read, stop,
    set(value: FrameSnapshot | null) { counters = value; },
    counters: () => counters!,
    sample(elapsed: number) { now += elapsed; [...pending.values()].forEach(callback => callback()); },
    hide(hidden: boolean) {
      source.document.hidden = hidden;
      listeners.forEach(listener => { if (typeof listener === "function") listener(new Event("visibilitychange")); });
    }
  };
}

describe("画布帧统计", () => {
  it("从 Bevy 完成数计算 FPS，使用实际经过时间", () => {
    const env = harness();
    env.set({ ...env.counters(), renders: 160, updates: 175 });
    env.sample(1250);
    expect(env.publish.mock.lastCall![0]).toEqual({ fps: 48, updatesPerSecond: 60, averageMs: 1250 / 60, drawCalls3d: null });
    env.stop();
  });

  it("没有渲染时显示 0，不回退浏览器回调频率", () => {
    const env = harness();
    env.sample(1000);
    expect(env.publish.mock.lastCall![0]).toEqual({ fps: 0, updatesPerSecond: 0, averageMs: null, drawCalls3d: null });
    env.stop();
  });

  it("Draw Call 按窗口内实际渲染帧数平均，0 次绘制也有效", () => {
    const env = harness(1000);
    env.set({ ...env.counters(), renders: 160, updates: 175, drawCalls3d: 1300 });
    env.sample(1250);
    expect(env.publish.mock.lastCall![0]).toMatchObject({ fps: 48, drawCalls3d: 5 });
    env.set({ ...env.counters(), renders: 190 });
    env.sample(1000);
    expect(env.publish.mock.lastCall![0].drawCalls3d).toBe(0);
    env.sample(1000);
    expect(env.publish.mock.lastCall![0].drawCalls3d).toBeNull();
    env.stop();
  });

  it.each([undefined, -1, NaN, Infinity, 999, 1000.5])("Draw Call 缺失、非法或回退不影响 FPS：%s", draws => {
    const env = harness(1000);
    env.set({ ...env.counters(), renders: 160, drawCalls3d: draws });
    env.sample(1000);
    expect(env.publish.mock.lastCall![0]).toMatchObject({ fps: 60, drawCalls3d: null });
    env.stop();
  });

  it.each(["instance", "generation", "reset"])("%s 改变时重新建立基线", kind => {
    const env = harness();
    const value = env.counters();
    env.set({ ...value, ...(kind === "instance" ? { instance: {} } : kind === "generation" ? { generation: 2 } : { renders: 0, updates: 0 }) });
    env.sample(1000);
    expect(env.publish.mock.lastCall![0]).toBeNull();
    env.set({ ...env.counters(), renders: env.counters().renders + 60, updates: env.counters().updates + 60 });
    env.sample(1000);
    expect(env.publish.mock.lastCall![0].fps).toBe(60);
    env.stop();
  });

  it("旧 WASM 不支持计数或恢复期间不可读时显示缺失", () => {
    const env = harness();
    env.set(null);
    env.sample(1000);
    expect(env.publish.mock.lastCall![0]).toBeNull();
    env.read.mockImplementationOnce(() => { throw new Error("runtime unavailable"); });
    expect(() => env.sample(1000)).not.toThrow();
    expect(env.publish.mock.lastCall![0]).toBeNull();
    env.stop();
  });

  it("后台暂停，恢复时重置基线，卸载时释放资源", () => {
    const env = harness();
    env.hide(true);
    expect(env.pending.size).toBe(0);
    const reads = env.read.mock.calls.length;
    env.sample(100000);
    expect(env.read).toHaveBeenCalledTimes(reads);
    env.set({ ...env.counters(), renders: 5000, updates: 5000 });
    env.hide(false);
    expect(env.publish.mock.lastCall![0]).toBeNull();
    env.set({ ...env.counters(), renders: 5060, updates: 5060 });
    env.sample(1000);
    expect(env.publish.mock.lastCall![0].fps).toBe(60);
    env.stop();
    expect(env.pending.size).toBe(0);
    expect(env.listeners.size).toBe(0);
  });
});
