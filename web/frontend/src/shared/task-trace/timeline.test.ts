/**
 * 生命周期时间线归并（change: 生成溯源时间线可读性）。
 *
 * 关键回归：轮询每秒钟一条 progress 事件，原样渲染会把「执行中」刷成几十行。
 * 归并只合并**连续同阶段**，不能把中间夹了别的阶段的同阶段事件并到一起。
 */
import { describe, expect, it } from "vitest";
import { formatClockRange, groupTimeline } from "./timeline.js";

function event(sequence: number, stage: string, at: string, kind: "scheduling" | "execution" = "execution") {
  return { sequence, stage, occurredAt: at, kind } as never;
}

describe("groupTimeline", () => {
  it("连续同阶段归并成一段，保留起止与次数", () => {
    const rows = groupTimeline([
      event(0, "queued", "2026-10-17T00:20:55.000Z", "scheduling"),
      event(1, "running", "2026-10-17T00:20:56.000Z"),
      event(2, "running", "2026-10-17T00:20:57.000Z"),
      event(3, "running", "2026-10-17T00:20:58.000Z"),
      event(4, "succeeded", "2026-10-17T00:21:09.000Z")
    ]);
    expect(rows.map((row) => [row.stage, row.count])).toEqual([
      ["queued", 1],
      ["running", 3],
      ["succeeded", 1]
    ]);
    expect(rows[1]).toMatchObject({
      firstAt: "2026-10-17T00:20:56.000Z",
      lastAt: "2026-10-17T00:20:58.000Z"
    });
  });

  it("非连续的相同阶段不合并（中间夹了别的阶段）", () => {
    const rows = groupTimeline([
      event(0, "running", "2026-10-17T00:00:01.000Z"),
      event(1, "provider.started", "2026-10-17T00:00:02.000Z"),
      event(2, "running", "2026-10-17T00:00:03.000Z")
    ]);
    expect(rows.map((row) => row.stage)).toEqual(["running", "provider.started", "running"]);
  });

  it("同阶段但不同类别不合并（调度 vs 执行是两相）", () => {
    const rows = groupTimeline([
      event(0, "queued", "2026-10-17T00:00:01.000Z", "scheduling"),
      event(1, "queued", "2026-10-17T00:00:02.000Z", "execution")
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.kind)).toEqual(["scheduling", "execution"]);
  });

  it("空输入得到空时间线", () => {
    expect(groupTimeline([])).toEqual([]);
  });
});

describe("formatClockRange", () => {
  it("单条只显示时刻", () => {
    expect(formatClockRange({ firstAt: "2026-10-17T00:20:55.000Z", lastAt: "2026-10-17T00:20:55.000Z", count: 1 }))
      .toBe(new Date("2026-10-17T00:20:55.000Z").toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }));
  });

  it("多条显示起止范围", () => {
    const label = formatClockRange({ firstAt: "2026-10-17T00:20:56.000Z", lastAt: "2026-10-17T00:21:09.000Z", count: 14 });
    expect(label).toContain("–");
    expect(label.split(" – ")).toHaveLength(2);
  });

  it("跨天时结束时刻补日期，避免范围误读", () => {
    // 用本地时间构造，保证在任意时区下都真的跨天。
    const first = new Date(2026, 9, 17, 23, 59, 59).toISOString();
    const last = new Date(2026, 9, 18, 0, 0, 5).toISOString();
    const label = formatClockRange({ firstAt: first, lastAt: last, count: 3 });
    expect(label).toMatch(/\d{2}\/\d{2}/);
  });
});
