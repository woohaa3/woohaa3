/**
 * 帧窗口装配点测试（change: 2026-10-25-enhance-telemetry-performance-collection，任务 3.5）。
 *
 * 装配点只做三件事：把 `scene-diagnostics` 的计数接到窗口、把页面可见性接到"丢半窗"、
 * dispose 时解绑监听。这里守的是后两件——计数映射由 `telemetry-performance.test.ts` 覆盖。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { installPerfFrameWindow } from "./perf-frame-window.js";

function fakeDocument(visible = true) {
  const listeners = new Map<string, Set<() => void>>();
  const doc = {
    hidden: !visible,
    visibilityState: visible ? "visible" : "hidden",
    addEventListener: (type: string, handler: () => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(handler);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, handler: () => void) => {
      listeners.get(type)?.delete(handler);
    }
  };
  return {
    doc,
    listeners: () => listeners,
    fire: (type: string) => {
      for (const handler of [...(listeners.get(type) ?? [])]) handler();
    }
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("帧窗口装配", () => {
  it("把 visibilitychange 接到窗口并只保留一个监听", () => {
    // 装配点用真实定时器（60 s 窗口）；测试换成假定时器，避免留下悬挂句柄。
    vi.useFakeTimers();
    const fake = fakeDocument();
    vi.stubGlobal("document", fake.doc);
    const window = installPerfFrameWindow();
    expect(fake.listeners().get("visibilitychange")?.size).toBe(1);
    expect(() => fake.fire("visibilitychange")).not.toThrow();
    window.dispose();
    expect(fake.listeners().get("visibilitychange")?.size ?? 0).toBe(0);
  });

  it("没有 document 时仍能创建与释放（原生/测试环境）", () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", undefined);
    const window = installPerfFrameWindow();
    expect(() => window.dispose()).not.toThrow();
    // 重复释放不抛错。
    window.dispose();
  });
});
