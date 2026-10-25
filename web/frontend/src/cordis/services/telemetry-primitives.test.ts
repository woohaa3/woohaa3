/**
 * 启动计时原语测试（change: 2026-10-25-enhance-telemetry-performance-collection，任务 3.5）。
 *
 * 关键口径：**采集条件在结束时判定**。客户端是 App scope 启动后动态 import 安装的，
 * 如果在 `beginStartupSpan` 开始时就判条件，`app-scope` 这段最值钱的启动耗时永远拿不到。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { TelemetryEventInput } from "@woohaa3/contracts";
import {
  beginStartupSpan,
  isPerfCollectionEnabled,
  recordStartupSpan,
  resolveTelemetryBuildMode,
  setTelemetryBuildModeForTesting,
  setTelemetryClientForTesting,
  telemetryBuildMode
} from "./telemetry-primitives.js";

function client() {
  const events: TelemetryEventInput[] = [];
  return {
    events,
    record: (input: TelemetryEventInput) => events.push(input),
    flush: () => undefined,
    status: () => ({ queued: events.length, droppedOverflow: 0, droppedInvalid: 0, droppedFailed: 0 }),
    dispose: () => undefined
  };
}

afterEach(() => {
  setTelemetryClientForTesting(undefined);
  setTelemetryBuildModeForTesting(undefined);
});

describe("构建模式解析", () => {
  it("dev / preview / production 由编译期常量决定", () => {
    expect(resolveTelemetryBuildMode({ DEV: true, MODE: "development" })).toBe("dev");
    expect(resolveTelemetryBuildMode({ DEV: false, MODE: "preview" })).toBe("preview");
    expect(resolveTelemetryBuildMode({ DEV: false, MODE: "production" })).toBe("production");
    // 桌面壳用 `desktop` 模式，对遥测而言也是发布构建。
    expect(resolveTelemetryBuildMode({ DEV: false, MODE: "desktop" })).toBe("production");
  });

  it("构建常量缺失返回 undefined，不以 unknown 占位", () => {
    expect(resolveTelemetryBuildMode(null)).toBeUndefined();
    expect(resolveTelemetryBuildMode({ DEV: false })).toBeUndefined();
  });

  it("测试可以固定/清除模块级模式", () => {
    setTelemetryBuildModeForTesting("preview");
    expect(telemetryBuildMode()).toBe("preview");
    setTelemetryBuildModeForTesting(undefined);
    expect(telemetryBuildMode()).toBeUndefined();
  });
});

describe("启动阶段计时", () => {
  it("开始时没有客户端、结束时已安装：仍然发出这条事实", () => {
    setTelemetryBuildModeForTesting("dev");
    setTelemetryClientForTesting(undefined);
    // App scope 刚开始时采集客户端还没动态 import 完成。
    expect(isPerfCollectionEnabled()).toBe(false);
    const finish = beginStartupSpan("app-scope");
    const sink = client();
    setTelemetryClientForTesting(sink);
    finish();

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      name: "perf.startup",
      result: "success",
      origin: "browser",
      surface: "canvas"
    });
    expect(sink.events[0]?.attributes).toEqual({ mode: "dev", stage: "app-scope" });
  });

  it("构建模式缺失时结束也不发（不以 unknown 占位）", () => {
    const sink = client();
    setTelemetryClientForTesting(sink);
    setTelemetryBuildModeForTesting(undefined);
    const finish = beginStartupSpan("canvas-scope");
    finish();
    expect(sink.events).toHaveLength(0);
  });

  it("重复结束只发一次，失败结果被保留", () => {
    setTelemetryBuildModeForTesting("production");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const finish = beginStartupSpan("wasm-module");
    finish("failure");
    finish("success");
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.result).toBe("failure");
  });

  it("recordStartupSpan 直接写已测好的耗时", () => {
    setTelemetryBuildModeForTesting("preview");
    const sink = client();
    setTelemetryClientForTesting(sink);
    recordStartupSpan("scene-build", 42);
    expect(sink.events[0]?.durationMs).toBe(42);
    expect(sink.events[0]?.attributes).toEqual({ mode: "preview", stage: "scene-build" });
  });

  it("采集客户端抛错不冒泡到调用方", () => {
    setTelemetryBuildModeForTesting("dev");
    setTelemetryClientForTesting({
      record: () => { throw new Error("intake down"); },
      flush: () => undefined,
      status: () => ({ queued: 0, droppedOverflow: 0, droppedInvalid: 0, droppedFailed: 0 }),
      dispose: () => undefined
    });
    const finish = beginStartupSpan("session-open");
    expect(() => finish()).not.toThrow();
  });
});
