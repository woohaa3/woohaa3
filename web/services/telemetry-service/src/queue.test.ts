/**
 * 有界事件队列测试（change: 2026-10-20-add-local-client-telemetry，design D7）。
 *
 * 队列是"业务路径永不阻塞"的兜底：这些用例守的是容量语义与丢弃计数——丢了多少必须能被
 * `status().droppedOverflow` 如实看见。
 */
import { describe, expect, it } from "vitest";
import type { TelemetryEvent } from "@woohaa3/contracts";
import { TELEMETRY_FLUSH_BATCH, TELEMETRY_QUEUE_CAPACITY, TelemetryEventQueue } from "./queue.js";

function makeEvent(name: TelemetryEvent["name"] = "canvas.open"): TelemetryEvent {
  return { name, result: "success", origin: "browser", occurredAt: 0 };
}

describe("TelemetryEventQueue", () => {
  it("按 FIFO 顺序取出，最多取 max 条", () => {
    const queue = new TelemetryEventQueue(10);
    queue.enqueue(makeEvent("canvas.open"));
    queue.enqueue(makeEvent("canvas.save"));
    queue.enqueue(makeEvent("sync.connect"));

    expect(queue.take(2).map((event) => event.name)).toEqual(["canvas.open", "canvas.save"]);
    expect(queue.size).toBe(1);
    expect(queue.take(10).map((event) => event.name)).toEqual(["sync.connect"]);
    expect(queue.size).toBe(0);
  });

  it("队列满时丢最旧并累计 droppedOverflow", () => {
    const queue = new TelemetryEventQueue(2);
    expect(queue.enqueue(makeEvent("canvas.open"))).toBe(0);
    expect(queue.enqueue(makeEvent("canvas.save"))).toBe(0);
    // 第三条挤掉最旧的 `canvas.open`。
    expect(queue.enqueue(makeEvent("sync.connect"))).toBe(1);

    expect(queue.size).toBe(2);
    expect(queue.droppedOverflow).toBe(1);
    expect(queue.take(2).map((event) => event.name)).toEqual(["canvas.save", "sync.connect"]);
    // 计数只增不减：它记录的是"这段运行期丢了多少"。
    expect(queue.droppedOverflow).toBe(1);
  });

  it("take 非正数时返回空数组且不丢事件", () => {
    const queue = new TelemetryEventQueue(4);
    queue.enqueue(makeEvent());
    expect(queue.take(0)).toEqual([]);
    expect(queue.take(-1)).toEqual([]);
    expect(queue.size).toBe(1);
  });

  it("clear 清空事件但保留丢弃计数", () => {
    const queue = new TelemetryEventQueue(1);
    queue.enqueue(makeEvent("canvas.open"));
    queue.enqueue(makeEvent("canvas.save"));

    queue.clear();

    expect(queue.size).toBe(0);
    expect(queue.droppedOverflow).toBe(1);
  });

  it("容量至少为 1，且小数向下取整", () => {
    // 容量 0 会退化成"每条都丢"的隐式开关，而开关该由设置项表达。
    const zero = new TelemetryEventQueue(0);
    zero.enqueue(makeEvent("canvas.open"));
    expect(zero.size).toBe(1);

    const fractional = new TelemetryEventQueue(2.9);
    fractional.enqueue(makeEvent("canvas.open"));
    fractional.enqueue(makeEvent("canvas.save"));
    fractional.enqueue(makeEvent("sync.connect"));
    expect(fractional.size).toBe(2);
    expect(fractional.droppedOverflow).toBe(1);
  });

  it("容量与批大小常量与 design 一致", () => {
    expect(TELEMETRY_QUEUE_CAPACITY).toBe(2048);
    expect(TELEMETRY_FLUSH_BATCH).toBe(64);
  });
});
