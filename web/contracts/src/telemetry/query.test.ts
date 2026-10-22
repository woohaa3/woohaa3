/**
 * 本机遥测查询契约测试（change: 2026-10-20-add-local-client-telemetry，任务 6.3/6.4 的契约部分）。
 *
 * 锁定两件事：
 * - 非法筛选值**返回稳定错误码**，不静默夹到合法值（静默纠正会让"我筛了"与"界面显示"对不上）；
 * - 窗口/分桶是封闭枚举，分桶缺省由窗口推导，避免 7 天被切成 10080 个点。
 */
import { describe, expect, it } from "vitest";
import {
  TELEMETRY_PAGE_SIZE_MAX,
  defaultTelemetryBucket,
  isTelemetryBucket,
  isTelemetryWindow,
  parseTelemetryEventFilter
} from "./query.js";

describe("窗口与分桶", () => {
  it("只接受四档窗口", () => {
    for (const window of ["1h", "6h", "24h", "7d"]) expect(isTelemetryWindow(window)).toBe(true);
    for (const window of ["2h", "30d", "", null, 24]) expect(isTelemetryWindow(window)).toBe(false);
  });

  it("只接受三档分桶", () => {
    for (const bucket of ["1m", "5m", "1h"]) expect(isTelemetryBucket(bucket)).toBe(true);
    for (const bucket of ["1s", "1d", ""]) expect(isTelemetryBucket(bucket)).toBe(false);
  });

  it("分桶缺省由窗口推导", () => {
    expect(defaultTelemetryBucket("1h")).toBe("1m");
    expect(defaultTelemetryBucket("6h")).toBe("5m");
    expect(defaultTelemetryBucket("24h")).toBe("1h");
    expect(defaultTelemetryBucket("7d")).toBe("1h");
  });
});

describe("筛选解析", () => {
  it("空参数得到空筛选（窗口交给调用方补缺省）", () => {
    const parsed = parseTelemetryEventFilter({});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.filter).toEqual({});
  });

  it("窗口非法返回稳定错误码", () => {
    const parsed = parseTelemetryEventFilter({ window: "3h" });
    expect(parsed).toEqual({ ok: false, code: "invalid-window", message: "未知的时间窗口" });
  });

  it("name 支持重复参数与逗号串", () => {
    const fromArray = parseTelemetryEventFilter({ name: ["canvas.save", "sync.connect"] });
    const fromCsv = parseTelemetryEventFilter({ names: "canvas.save,sync.connect" });
    expect(fromArray.ok && fromArray.filter.names).toEqual(["canvas.save", "sync.connect"]);
    expect(fromCsv.ok && fromCsv.filter.names).toEqual(["canvas.save", "sync.connect"]);
  });

  it("重复事件名去重", () => {
    const parsed = parseTelemetryEventFilter({ name: "canvas.save,canvas.save" });
    expect(parsed.ok && parsed.filter.names).toEqual(["canvas.save"]);
  });

  it("未知事件名返回错误码", () => {
    const parsed = parseTelemetryEventFilter({ name: "prompt.viewed" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe("invalid-name");
  });

  it("未知结果返回错误码", () => {
    const parsed = parseTelemetryEventFilter({ result: "partial" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe("invalid-result");
  });

  it("错误码形状非法返回错误码", () => {
    for (const errorCode of ["Canvas Save Failed", "a".repeat(65)]) {
      const parsed = parseTelemetryEventFilter({ errorCode });
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.code).toBe("invalid-error-code");
    }
  });

  it("游标过长返回错误码", () => {
    const parsed = parseTelemetryEventFilter({ cursor: "x".repeat(65) });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe("invalid-cursor");
  });

  it("limit 只接受 1..上限的整数", () => {
    expect(parseTelemetryEventFilter({ limit: "50" }).ok).toBe(true);
    for (const limit of ["0", "-1", String(TELEMETRY_PAGE_SIZE_MAX + 1), "1.5", "abc"]) {
      const parsed = parseTelemetryEventFilter({ limit });
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.code).toBe("invalid-limit");
    }
  });

  it("正常组合被完整保留", () => {
    const parsed = parseTelemetryEventFilter({
      window: "24h",
      name: "canvas.save",
      result: "failure",
      errorCode: "canvas.save.timeout",
      cursor: "42",
      limit: "20"
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.filter).toEqual({
      window: "24h",
      names: ["canvas.save"],
      results: ["failure"],
      errorCode: "canvas.save.timeout",
      cursor: "42",
      limit: 20
    });
  });
});
