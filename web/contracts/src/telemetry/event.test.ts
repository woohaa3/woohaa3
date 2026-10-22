/**
 * 本机遥测事件契约测试（change: 2026-10-20-add-local-client-telemetry，任务 6.1）。
 *
 * 锁定三件事：
 * - 白名单：未知 `name`/`result`/`origin` 整条丢弃，其它字段非法只丢字段；
 * - 有界：耗时、错误码、trace、版本、属性各自的上限，中文按码点截断不被切坏；
 * - 不采集内容：结构上就没有能装 prompt/标题/URL 的字段，属性键只认白名单。
 */
import { describe, expect, it } from "vitest";
import {
  TELEMETRY_LIMITS,
  foldSingleLine,
  isTelemetryEventName,
  normalizeTelemetryEvent,
  truncateByCodePoints
} from "./event.js";

const NOW = Date.UTC(2026, 9, 20, 2, 0, 0);

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "canvas.save", result: "success", origin: "browser", ...overrides };
}

describe("白名单", () => {
  it("接受白名单内的事件名", () => {
    expect(isTelemetryEventName("canvas.save")).toBe(true);
    expect(isTelemetryEventName("task.terminal")).toBe(true);
  });

  it("拒绝白名单外的事件名", () => {
    expect(isTelemetryEventName("prompt.viewed")).toBe(false);
    expect(isTelemetryEventName("")).toBe(false);
  });

  it("未知 name 整条丢弃", () => {
    expect(normalizeTelemetryEvent(base({ name: "prompt.viewed" }), { now: NOW })).toBeNull();
  });

  it("未知 result 整条丢弃", () => {
    expect(normalizeTelemetryEvent(base({ result: "partial" }), { now: NOW })).toBeNull();
  });

  it("未知 origin 整条丢弃", () => {
    expect(normalizeTelemetryEvent(base({ origin: "server" }), { now: NOW })).toBeNull();
  });

  it("非对象输入丢弃", () => {
    expect(normalizeTelemetryEvent(null, { now: NOW })).toBeNull();
    expect(normalizeTelemetryEvent("canvas.save", { now: NOW })).toBeNull();
  });
});

describe("字段级非法值只丢该字段", () => {
  it("未知 surface 被丢掉但事件保留", () => {
    const event = normalizeTelemetryEvent(base({ surface: "settings" }), { now: NOW });
    expect(event).not.toBeNull();
    expect(event?.surface).toBeUndefined();
  });

  it("越界耗时被丢掉但事件保留", () => {
    const negative = normalizeTelemetryEvent(base({ durationMs: -1 }), { now: NOW });
    const tooLarge = normalizeTelemetryEvent(base({ durationMs: TELEMETRY_LIMITS.maxDurationMs + 1 }), { now: NOW });
    const notNumber = normalizeTelemetryEvent(base({ durationMs: "120" }), { now: NOW });
    expect(negative?.durationMs).toBeUndefined();
    expect(tooLarge?.durationMs).toBeUndefined();
    expect(notNumber?.durationMs).toBeUndefined();
  });

  it("合法耗时被四舍五入保留", () => {
    expect(normalizeTelemetryEvent(base({ durationMs: 12.6 }), { now: NOW })?.durationMs).toBe(13);
  });

  it("非法错误码被丢掉", () => {
    for (const errorCode of ["Canvas Save Failed", "上限", "a".repeat(65), "", "-leading"]) {
      expect(normalizeTelemetryEvent(base({ errorCode }), { now: NOW })?.errorCode).toBeUndefined();
    }
  });

  it("合法错误码被保留", () => {
    expect(normalizeTelemetryEvent(base({ errorCode: "canvas.save.timeout" }), { now: NOW })?.errorCode).toBe(
      "canvas.save.timeout"
    );
  });

  it("traceId 必须是 32 位十六进制，全零无意义被丢", () => {
    const valid = "0123456789abcdef0123456789abcdef";
    expect(normalizeTelemetryEvent(base({ traceId: valid }), { now: NOW })?.traceId).toBe(valid);
    expect(normalizeTelemetryEvent(base({ traceId: valid.toUpperCase() }), { now: NOW })?.traceId).toBe(valid);
    expect(normalizeTelemetryEvent(base({ traceId: "0".repeat(32) }), { now: NOW })?.traceId).toBeUndefined();
    expect(normalizeTelemetryEvent(base({ traceId: "abc" }), { now: NOW })?.traceId).toBeUndefined();
  });

  it("frontendVersion 只接受版本形状", () => {
    expect(normalizeTelemetryEvent(base({ frontendVersion: "v1.4.2-3-gabc1234-dirty" }), { now: NOW })?.frontendVersion).toBe(
      "v1.4.2-3-gabc1234-dirty"
    );
    for (const frontendVersion of ["1.0 build", "", "-v1", "a".repeat(65)]) {
      expect(normalizeTelemetryEvent(base({ frontendVersion }), { now: NOW })?.frontendVersion).toBeUndefined();
    }
  });
});

describe("时间", () => {
  it("缺失/非法/非正时间为未知", () => {
    expect(normalizeTelemetryEvent(base(), { now: NOW })?.occurredAt).toBe(0);
    expect(normalizeTelemetryEvent(base({ occurredAt: "not-a-date" }), { now: NOW })?.occurredAt).toBe(0);
    expect(normalizeTelemetryEvent(base({ occurredAt: -5 }), { now: NOW })?.occurredAt).toBe(0);
  });

  it("超前超过可接受偏差视为不可信", () => {
    const skew = TELEMETRY_LIMITS.maxClockSkewMs + 1000;
    expect(normalizeTelemetryEvent(base({ occurredAt: NOW + skew }), { now: NOW })?.occurredAt).toBe(0);
    expect(normalizeTelemetryEvent(base({ occurredAt: NOW + 1000 }), { now: NOW })?.occurredAt).toBe(NOW + 1000);
  });
});

describe("属性", () => {
  it("白名单外的键逐对丢弃", () => {
    const event = normalizeTelemetryEvent(
      base({ attributes: { canvas: "c1", prompt: "画一只猫", title: "未命名" } }),
      { now: NOW }
    );
    expect(event?.attributes).toEqual({ canvas: "c1" });
  });

  it("一个都不合法时不保留 attributes", () => {
    expect(normalizeTelemetryEvent(base({ attributes: { prompt: "x" } }), { now: NOW })?.attributes).toBeUndefined();
    expect(normalizeTelemetryEvent(base({ attributes: [] }), { now: NOW })?.attributes).toBeUndefined();
  });

  it("控制字符与换行折叠成单行", () => {
    const event = normalizeTelemetryEvent(base({ attributes: { phase: "line1\n\tline2\u0000" } }), { now: NOW });
    expect(event?.attributes?.phase).toBe("line1 line2");
  });

  it("中文按码点截断不切坏代理对", () => {
    const long = "图画".repeat(TELEMETRY_LIMITS.maxAttributeValueLength);
    const event = normalizeTelemetryEvent(base({ attributes: { source: long } }), { now: NOW });
    const value = String(event?.attributes?.source);
    expect(Array.from(value).length).toBe(TELEMETRY_LIMITS.maxAttributeValueLength);
    expect(value).toBe("图画".repeat(TELEMETRY_LIMITS.maxAttributeValueLength / 2));
  });

  it("超过条数上限时按排序丢弃尾部", () => {
    const attributes: Record<string, string> = {};
    const keys = ["canvas", "node", "provider", "model", "phase", "status", "code", "source", "version"];
    for (const [index, key] of keys.entries()) attributes[key] = `v${index}`;
    const event = normalizeTelemetryEvent(base({ attributes }), { now: NOW });
    expect(Object.keys(event?.attributes ?? {})).toHaveLength(TELEMETRY_LIMITS.maxAttributes);
    expect(Object.keys(event?.attributes ?? {})).toEqual(
      [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, TELEMETRY_LIMITS.maxAttributes)
    );
  });

  it("非标量值与空串被丢弃", () => {
    const event = normalizeTelemetryEvent(
      base({ attributes: { canvas: { nested: true }, node: "", provider: "   " } }),
      { now: NOW }
    );
    expect(event?.attributes).toBeUndefined();
  });
});

describe("辅助函数", () => {
  it("truncateByCodePoints 不切坏码点", () => {
    expect(truncateByCodePoints("图画图画", 2)).toBe("图画");
    expect(truncateByCodePoints("短", 10)).toBe("短");
  });

  it("foldSingleLine 去掉首尾空白", () => {
    expect(foldSingleLine("  a  b  ")).toBe("a b");
  });
});
