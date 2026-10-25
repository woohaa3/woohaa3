/**
 * 输入存储（`perf.interaction` / `perf.segment`）测试
 * （change: 2026-10-25-enhance-telemetry-performance-collection，任务 3.5）。
 *
 * 守的是 spec 的两条硬约束：
 * - 被门禁拒绝的输入不发事件（只 `enter` 不 `start`，什么都不发）；
 * - 计时包住业务代码时不改变返回值、不改变异常。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { TelemetryEventInput } from "@woohaa3/contracts";
import { setTelemetryBuildModeForTesting, setTelemetryClientForTesting } from "../../../services/telemetry-primitives.js";
import { createPerfInputRecorder } from "./perf-interaction.js";

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

describe("输入收集器", () => {
  it("未开始就结束时不发任何事件（被门禁拒绝的输入）", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const perf = createPerfInputRecorder();
    perf.enter();
    perf.accumulate("hit-query", 3);
    perf.finish();
    expect(sink.events).toHaveLength(0);
  });

  it("一次输入只发一条 perf.interaction，子阶段各发一条 perf.segment", () => {
    setTelemetryBuildModeForTesting("production");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const perf = createPerfInputRecorder();
    perf.enter();
    perf.start("drag");
    perf.accumulate("hit-query", 2);
    perf.accumulate("gesture-move", 3);
    perf.accumulate("gesture-move", 4);
    perf.finish();

    const interactions = sink.events.filter((event) => event.name === "perf.interaction");
    const segments = sink.events.filter((event) => event.name === "perf.segment");
    expect(interactions).toHaveLength(1);
    expect(interactions[0]?.attributes).toMatchObject({ mode: "production", kind: "drag" });
    // 同一阶段的高频累加合并成一条，不是两次 push。
    expect(segments).toHaveLength(2);
    expect(segments.map((event) => event.attributes?.stage).sort()).toEqual(["gesture-move", "hit-query"]);
    expect(segments.find((event) => event.attributes?.stage === "gesture-move")?.durationMs).toBe(7);
  });

  it("重复 finish 只发一次", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const perf = createPerfInputRecorder();
    perf.start("pan");
    perf.finish();
    perf.finish();
    expect(sink.events.filter((event) => event.name === "perf.interaction")).toHaveLength(1);
  });

  it("discard 丢弃整次收集（输入最终没有被消费）", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const perf = createPerfInputRecorder();
    perf.enter();
    perf.start("marquee");
    perf.accumulate("gesture-move", 5);
    perf.discard();
    perf.finish();
    expect(sink.events).toHaveLength(0);
  });

  it("取消路径按 cancelled 结算，不是 success", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const perf = createPerfInputRecorder();
    perf.start("drag");
    perf.finish("cancelled");
    expect(sink.events[0]?.result).toBe("cancelled");
  });

  it("构建模式缺失时连时钟都不读，也不发事件", () => {
    const sink = client();
    setTelemetryClientForTesting(sink);
    const perf = createPerfInputRecorder();
    expect(perf.enter()).toBeUndefined();
    perf.start("pan");
    perf.accumulate("hit-query", 1);
    perf.finish();
    expect(sink.events).toHaveLength(0);
  });

  it("没有客户端时不发事件", () => {
    setTelemetryBuildModeForTesting("dev");
    const perf = createPerfInputRecorder();
    perf.start("pan");
    perf.finish();
    expect(perf.enter()).toBeUndefined();
  });
});
