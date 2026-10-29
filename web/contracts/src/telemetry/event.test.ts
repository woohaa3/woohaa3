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
  TELEMETRY_ATTRIBUTE_KEYS,
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
    // 用白名单全集而不是手写几个键：上限是契约常量，键集合也来自同一个常量，
    // 这样新增属性键时不会悄悄把这条测试变成"没到上限也通过"。
    const keys = [...TELEMETRY_ATTRIBUTE_KEYS];
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

describe("性能事件（change: 2026-10-25-enhance-telemetry-performance-collection）", () => {
  it("四个新事件名都在白名单里", () => {
    for (const name of ["perf.startup", "perf.interaction", "perf.segment", "perf.frame"]) {
      expect(isTelemetryEventName(name)).toBe(true);
    }
  });

  it("perf.startup 归一：durationMs + stage + mode", () => {
    const event = normalizeTelemetryEvent(
      base({ name: "perf.startup", durationMs: 128, attributes: { mode: "dev", stage: "wasm-module" } }),
      { now: NOW }
    );
    expect(event?.name).toBe("perf.startup");
    expect(event?.durationMs).toBe(128);
    expect(event?.attributes).toEqual({ mode: "dev", stage: "wasm-module" });
  });

  it("perf.interaction 归一：kind + mode", () => {
    const event = normalizeTelemetryEvent(
      base({ name: "perf.interaction", durationMs: 4.4, attributes: { mode: "production", kind: "wheel-pan" } }),
      { now: NOW }
    );
    expect(event?.durationMs).toBe(4);
    expect(event?.attributes).toEqual({ mode: "production", kind: "wheel-pan" });
  });

  it("perf.segment 归一：kind + stage + mode", () => {
    const event = normalizeTelemetryEvent(
      base({ name: "perf.segment", durationMs: 2, attributes: { mode: "dev", kind: "drag", stage: "gesture-commit" } }),
      { now: NOW }
    );
    expect(event?.attributes).toEqual({ mode: "dev", kind: "drag", stage: "gesture-commit" });
  });

  it("perf.frame 归一：窗口计数进属性，平均帧耗时进 durationMs", () => {
    const event = normalizeTelemetryEvent(
      base({
        name: "perf.frame",
        durationMs: 7,
        attributes: { mode: "dev", fps: 60, sceneBuilds: 3, sceneSubmits: 2, wasmAcceptMs: 12 }
      }),
      { now: NOW }
    );
    expect(event?.durationMs).toBe(7);
    expect(event?.attributes?.sceneBuilds).toBe(3);
    expect(event?.attributes?.mode).toBe("dev");
  });

  it("perf.lod 归一：档位分布进属性，不需要 durationMs", () => {
    // 2026-10-28 片场总览 LOD 遥测采样。
    const event = normalizeTelemetryEvent(
      base({
        name: "perf.lod",
        surface: "canvas",
        attributes: {
          mode: "production",
          low: 2,
          medium: 1,
          high: 3,
          preparing: 1,
          fractionMax: 0.412,
          reasons: "overview=5,offscreen=1"
        }
      }),
      { now: NOW }
    );
    expect(event?.name).toBe("perf.lod");
    expect(event?.durationMs).toBeUndefined();
    expect(event?.attributes).toEqual({
      mode: "production",
      low: 2,
      medium: 1,
      high: 3,
      preparing: 1,
      fractionMax: 0.412,
      reasons: "overview=5,offscreen=1"
    });
  });

  it("perf.lod 缺分布计数、出现负数或节点维度时整条丢弃", () => {
    // 缺 low/medium/high 之一：无法解释"哪个档位有多少片场"。
    expect(
      normalizeTelemetryEvent(base({ name: "perf.lod", attributes: { mode: "dev", low: 1, medium: 0 } }), { now: NOW })
    ).toBeNull();
    // 负数会让聚合表画出负档位。
    expect(
      normalizeTelemetryEvent(
        base({ name: "perf.lod", attributes: { mode: "dev", low: -1, medium: 0, high: 0 } }),
        { now: NOW }
      )
    ).toBeNull();
    // 逐节点事件走诊断面，不进入遥测白名单。
    expect(
      normalizeTelemetryEvent(
        base({ name: "perf.lod", attributes: { mode: "dev", low: 1, medium: 0, high: 0, node: "film-1" } }),
        { now: NOW }
      )
    ).toBeNull();
  });

  it("perf.lod 的 owners 只接受有界摘要串", () => {
    // dev 构建用来把「哪几个根停在 High」落到可回查的节点 id 末 12 字符；最多 3 条 + `+N`。
    const event = normalizeTelemetryEvent(
      base({
        name: "perf.lod",
        attributes: {
          mode: "dev",
          low: 1,
          medium: 0,
          high: 2,
          reasons: "overview=1,high-owner=2",
          owners: "1f2770cab380:high-owner,d4fa99cf-ad88:high-owner"
        }
      }),
      { now: NOW }
    );
    expect(event?.attributes?.owners).toBe("1f2770cab380:high-owner,d4fa99cf-ad88:high-owner");
  });

  it("perf.lod 的 owners 形状不合法时整条丢弃", () => {
    for (const owners of [
      "a:high-owner,b:high-owner,c:high-owner,d:high-owner,e:other",
      `${"x".repeat(41)}:other`
    ]) {
      expect(
        normalizeTelemetryEvent(
          base({ name: "perf.lod", attributes: { mode: "dev", low: 0, medium: 0, high: 1, owners } }),
          { now: NOW }
        )
      ).toBeNull();
    }
  });

  it("perf.lod 的 pins 只接受有界摘要串", () => {
    const event = normalizeTelemetryEvent(
      base({
        name: "perf.lod",
        attributes: {
          mode: "dev",
          low: 1,
          medium: 0,
          high: 2,
          pins: "shot-previe,1f2770cab380"
        }
      }),
      { now: NOW }
    );
    expect(event?.attributes?.pins).toBe("shot-previe,1f2770cab380");
  });

  it("perf.lod 的 pins 形状不合法时整条丢弃", () => {
    for (const pins of ["a,b,c,d,e", "x".repeat(41)]) {
      expect(
        normalizeTelemetryEvent(
          base({ name: "perf.lod", attributes: { mode: "dev", low: 0, medium: 0, high: 1, pins } }),
          { now: NOW }
        )
      ).toBeNull();
    }
  });

  it("pins 不属于其它性能事件的属性集合", () => {
    expect(
      normalizeTelemetryEvent(
        base({ name: "perf.frame", attributes: { mode: "dev", pins: "1f2770cab380" } }),
        { now: NOW }
      )
    ).toBeNull();
  });

  it("owners 不属于其它性能事件的属性集合", () => {
    expect(
      normalizeTelemetryEvent(
        base({ name: "perf.frame", attributes: { mode: "dev", owners: "1f2770cab380:other" } }),
        { now: NOW }
      )
    ).toBeNull();
  });

  it("缺 mode 的性能事件整条丢弃", () => {
    for (const name of ["perf.startup", "perf.interaction", "perf.segment", "perf.frame"]) {
      expect(normalizeTelemetryEvent(base({ name, attributes: {} }), { now: NOW })).toBeNull();
      expect(normalizeTelemetryEvent(base({ name }), { now: NOW })).toBeNull();
    }
  });

  it("mode 不是封闭枚举值时整条丢弃（不以 unknown 占位）", () => {
    const event = normalizeTelemetryEvent(
      base({ name: "perf.interaction", attributes: { mode: "unknown", kind: "pan" } }),
      { now: NOW }
    );
    expect(event).toBeNull();
  });

  it("未知 stage 整条丢弃", () => {
    const event = normalizeTelemetryEvent(
      base({ name: "perf.segment", attributes: { mode: "dev", kind: "pan", stage: "not-a-stage" } }),
      { now: NOW }
    );
    expect(event).toBeNull();
  });

  it("未知 kind 整条丢弃", () => {
    const event = normalizeTelemetryEvent(
      base({ name: "perf.interaction", attributes: { mode: "dev", kind: "pointermove" } }),
      { now: NOW }
    );
    expect(event).toBeNull();
  });

  it("属性键超出该事件的封闭集合时整条丢弃", () => {
    // perf.interaction 不接受 stage：混进来会让 groupBy 分组出现无法解释的空组。
    expect(
      normalizeTelemetryEvent(
        base({ name: "perf.interaction", attributes: { mode: "dev", kind: "pan", stage: "hit-query" } }),
        { now: NOW }
      )
    ).toBeNull();
  });

  it("同批里合法性能事件仍被保留（丢弃只针对坏的那条）", () => {
    const events = [
      base({ name: "perf.interaction", attributes: { mode: "dev", kind: "pan" } }),
      base({ name: "perf.interaction", attributes: { mode: "dev" } }),
      base({ name: "canvas.save" })
    ];
    const normalized = events.map((input) => normalizeTelemetryEvent(input, { now: NOW }));
    expect(normalized.filter((event) => event !== null)).toHaveLength(2);
    expect(normalized[1]).toBeNull();
  });

  it("非性能事件不受性能校验影响", () => {
    const event = normalizeTelemetryEvent(
      base({ name: "canvas.open", attributes: { phase: "load", mode: "dev" } }),
      { now: NOW }
    );
    expect(event?.attributes).toEqual({ mode: "dev", phase: "load" });
  });
});
