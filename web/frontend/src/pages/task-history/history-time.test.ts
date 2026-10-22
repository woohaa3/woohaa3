/**
 * 历史时间工具测试（change: improve-task-history-experience，任务 3.2）。
 */
import { describe, expect, it } from "vitest";
import {
  HISTORY_TIME_SHORTCUTS,
  isValidRange,
  isoToLocalDateTime,
  localDateTimeToIso,
  shortcutRange
} from "./history-time.js";

describe("history-time", () => {
  it("datetime-local 按本地时区解释为 ISO UTC，可往返", () => {
    const iso = localDateTimeToIso("2026-01-02T03:04");
    expect(iso).toBeDefined();
    expect(isoToLocalDateTime(iso)).toBe("2026-01-02T03:04");
  });

  it("非法输入返回 undefined / 空串", () => {
    expect(localDateTimeToIso("not-a-date")).toBeUndefined();
    expect(isoToLocalDateTime(undefined)).toBe("");
  });

  it("快捷项固定成绝对范围（from = now - hours）", () => {
    const now = new Date("2026-01-08T00:00:00.000Z");
    const range = shortcutRange(HISTORY_TIME_SHORTCUTS[0]!, now);
    expect(range.to).toBe("2026-01-08T00:00:00.000Z");
    expect(range.from).toBe("2026-01-07T00:00:00.000Z");
  });

  it("校验范围 from<=to", () => {
    expect(isValidRange(undefined, undefined)).toBe(true);
    expect(isValidRange("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z")).toBe(true);
    expect(isValidRange("2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z")).toBe(false);
    expect(isValidRange("bogus", "2026-01-01T00:00:00Z")).toBe(false);
  });
});
