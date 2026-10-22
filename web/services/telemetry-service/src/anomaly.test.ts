/**
 * 确定性异常规则测试（change: 2026-10-20-add-local-client-telemetry，design D6）。
 *
 * 四条规则都是纯函数，所以这里直接喂聚合结果、不碰存储与时钟。重点在**阈值边界**：
 * 复盘时用户会问"为什么你说这算异常"，边界就是答案，必须逐条钉住。
 */
import { describe, expect, it } from "vitest";
import type { TelemetryEventName } from "@woohaa3/contracts";
import {
  TELEMETRY_ANOMALY_RULE_ORDER,
  TELEMETRY_ANOMALY_THRESHOLDS,
  detectEventSilence,
  detectFailureRateSpike,
  detectLatencyRegression,
  detectNewErrorCodes,
  evaluateTelemetryAnomalies,
  type AnomalyErrorCode,
  type AnomalyNameInput,
  type AnomalyWindowStats
} from "./anomaly.js";

const WINDOW = "6h" as const;

/** 造一个窗口聚合；未给的度量取 0/缺省，让用例只表达它关心的差异。 */
function stats(input: {
  count: number;
  failures?: number;
  durationSamples?: number;
  durationP95?: number;
  errorCodes?: readonly AnomalyErrorCode[];
}): AnomalyWindowStats {
  return {
    count: input.count,
    failures: input.failures ?? 0,
    durationSamples: input.durationSamples ?? 0,
    ...(input.durationP95 === undefined ? {} : { durationP95: input.durationP95 }),
    ...(input.errorCodes === undefined ? {} : { errorCodes: input.errorCodes })
  };
}

function entry(input: {
  name?: TelemetryEventName;
  current: AnomalyWindowStats;
  previous?: AnomalyWindowStats;
  earlier?: number;
}): AnomalyNameInput {
  return {
    name: input.name ?? "canvas.open",
    current: input.current,
    previous: input.previous ?? stats({ count: 0 }),
    earlier: input.earlier ?? 0
  };
}

describe("failure-rate-spike", () => {
  it("当前窗口样本够、失败率过下限而基线低时命中", () => {
    const hit = detectFailureRateSpike(
      entry({ current: stats({ count: 20, failures: 4 }), previous: stats({ count: 20, failures: 0 }) }),
      WINDOW
    );

    expect(hit).toMatchObject({
      ruleId: "failure-rate-spike",
      severity: "warn",
      name: "canvas.open",
      window: WINDOW,
      observed: 0.2,
      baseline: 0,
      samples: 20
    });
    expect(hit?.evidence).toEqual({
      currentCount: 20,
      currentFailures: 4,
      currentRate: 0.2,
      baselineCount: 20,
      baselineFailures: 0,
      baselineRate: 0
    });
  });

  it("失败率达到 50% 时升级为 error", () => {
    const hit = detectFailureRateSpike(entry({ current: stats({ count: 20, failures: 10 }) }), WINDOW);
    expect(hit?.severity).toBe("error");
  });

  it("样本不足 20 时不命中（哪怕 100% 失败）", () => {
    expect(
      detectFailureRateSpike(entry({ current: stats({ count: 19, failures: 19 }) }), WINDOW)
    ).toBeUndefined();
  });

  it("失败率低于下限时不命中", () => {
    expect(
      detectFailureRateSpike(entry({ current: stats({ count: 20, failures: 3 }) }), WINDOW)
    ).toBeUndefined();
  });

  it("基线窗口本身失败率已到上限时不命中（本来就差，不算突变）", () => {
    expect(
      detectFailureRateSpike(
        entry({ current: stats({ count: 20, failures: 10 }), previous: stats({ count: 20, failures: 2 }) }),
        WINDOW
      )
    ).toBeUndefined();
  });

  it("基线窗口完全没有数据时按 0 处理：仍可命中，且证据里如实呈现 0 样本", () => {
    const hit = detectFailureRateSpike(
      entry({ current: stats({ count: 20, failures: 5 }), previous: stats({ count: 0 }) }),
      WINDOW
    );

    expect(hit).toBeDefined();
    expect(hit?.baseline).toBe(0);
    expect(hit?.evidence.baselineCount).toBe(0);
  });

  it("阈值常量与 design 表一致（20 样本 / 20% / 10% / 50%）", () => {
    expect(TELEMETRY_ANOMALY_THRESHOLDS.failureRateSamples).toBe(20);
    expect(TELEMETRY_ANOMALY_THRESHOLDS.failureRateObserved).toBe(0.2);
    expect(TELEMETRY_ANOMALY_THRESHOLDS.failureRateBaseline).toBe(0.1);
    expect(TELEMETRY_ANOMALY_THRESHOLDS.failureRateError).toBe(0.5);
  });
});

describe("new-error-code", () => {
  const code = (value: string, count: number, firstSeenAt = 1_000): AnomalyErrorCode => ({
    code: value,
    count,
    firstSeenAt
  });

  it("当前窗口出现且此前从未见过的错误码逐条命中", () => {
    const found = detectNewErrorCodes(
      entry({ current: stats({ count: 5, errorCodes: [code("new-code", 3), code("another-new", 1)] }) }),
      WINDOW,
      new Set<string>()
    );

    expect(found).toEqual([
      {
        ruleId: "new-error-code",
        severity: "warn",
        name: "canvas.open",
        window: WINDOW,
        observed: 3,
        baseline: 0,
        samples: 3,
        evidence: { code: "new-code", firstSeenAt: 1_000 }
      },
      {
        ruleId: "new-error-code",
        severity: "warn",
        name: "canvas.open",
        window: WINDOW,
        observed: 1,
        baseline: 0,
        samples: 1,
        evidence: { code: "another-new", firstSeenAt: 1_000 }
      }
    ]);
  });

  it("此前（基线或保留期内更早）出现过的错误码不命中", () => {
    const found = detectNewErrorCodes(
      entry({ current: stats({ count: 5, errorCodes: [code("old-code", 3)] }) }),
      WINDOW,
      new Set(["old-code"])
    );
    expect(found).toEqual([]);
  });

  it("当前窗口没有错误码时不命中", () => {
    expect(detectNewErrorCodes(entry({ current: stats({ count: 5 }) }), WINDOW, new Set())).toEqual([]);
  });
});

describe("latency-regression", () => {
  it("p95 达到基线 1.5 倍且两边样本都够时命中", () => {
    const hit = detectLatencyRegression(
      entry({
        current: stats({ count: 20, durationSamples: 20, durationP95: 300 }),
        previous: stats({ count: 20, durationSamples: 20, durationP95: 100 })
      }),
      WINDOW
    );

    expect(hit).toMatchObject({
      ruleId: "latency-regression",
      severity: "warn",
      observed: 300,
      baseline: 100,
      samples: 20
    });
    expect(hit?.evidence).toEqual({
      currentP95: 300,
      baselineP95: 100,
      ratio: 3,
      currentSamples: 20,
      baselineSamples: 20
    });
  });

  it("恰好 1.5 倍算命中（含边界）", () => {
    const hit = detectLatencyRegression(
      entry({
        current: stats({ count: 20, durationSamples: 20, durationP95: 150 }),
        previous: stats({ count: 20, durationSamples: 20, durationP95: 100 })
      }),
      WINDOW
    );
    expect(hit?.observed).toBe(150);
  });

  it("不到 1.5 倍不命中", () => {
    expect(
      detectLatencyRegression(
        entry({
          current: stats({ count: 20, durationSamples: 20, durationP95: 149 }),
          previous: stats({ count: 20, durationSamples: 20, durationP95: 100 })
        }),
        WINDOW
      )
    ).toBeUndefined();
  });

  it("当前窗口样本不足 20 不命中", () => {
    expect(
      detectLatencyRegression(
        entry({
          current: stats({ count: 19, durationSamples: 19, durationP95: 300 }),
          previous: stats({ count: 20, durationSamples: 20, durationP95: 100 })
        }),
        WINDOW
      )
    ).toBeUndefined();
  });

  it("基线窗口样本不足 20 不命中", () => {
    expect(
      detectLatencyRegression(
        entry({
          current: stats({ count: 20, durationSamples: 20, durationP95: 300 }),
          previous: stats({ count: 19, durationSamples: 19, durationP95: 100 })
        }),
        WINDOW
      )
    ).toBeUndefined();
  });

  it("基线 p95 为 0 不命中（0 不能当分母，否则一直是 0ms 会误报）", () => {
    expect(
      detectLatencyRegression(
        entry({
          current: stats({ count: 20, durationSamples: 20, durationP95: 50 }),
          previous: stats({ count: 20, durationSamples: 20, durationP95: 0 })
        }),
        WINDOW
      )
    ).toBeUndefined();
  });

  it("任一侧算不出 p95（没有耗时样本）不命中", () => {
    expect(
      detectLatencyRegression(
        entry({
          current: stats({ count: 20 }),
          previous: stats({ count: 20, durationSamples: 20, durationP95: 100 })
        }),
        WINDOW
      )
    ).toBeUndefined();
    expect(
      detectLatencyRegression(
        entry({
          current: stats({ count: 20, durationSamples: 20, durationP95: 300 }),
          previous: stats({ count: 20 })
        }),
        WINDOW
      )
    ).toBeUndefined();
  });
});

describe("event-silence", () => {
  it("当前窗口 0 条、前两窗各有足够计数时命中", () => {
    const hit = detectEventSilence(
      entry({ name: "sync.connect", current: stats({ count: 0 }), previous: stats({ count: 12 }), earlier: 7 }),
      WINDOW
    );

    expect(hit).toMatchObject({
      ruleId: "event-silence",
      severity: "warn",
      name: "sync.connect",
      observed: 0,
      baseline: 12,
      samples: 0
    });
    // 0 样本在界面上容易被读成"没数据"，所以两窗计数必须进证据。
    expect(hit?.evidence).toEqual({ current: 0, previous: 12, earlier: 7 });
  });

  it("当前窗口只要有 1 条就不算静默", () => {
    expect(
      detectEventSilence(entry({ current: stats({ count: 1 }), previous: stats({ count: 12 }), earlier: 12 }), WINDOW)
    ).toBeUndefined();
  });

  it("前一个窗口计数不足 5 不命中", () => {
    expect(
      detectEventSilence(entry({ current: stats({ count: 0 }), previous: stats({ count: 4 }), earlier: 12 }), WINDOW)
    ).toBeUndefined();
  });

  it("更早的窗口计数不足 5 不命中（无法证明此前确实在发生）", () => {
    expect(
      detectEventSilence(entry({ current: stats({ count: 0 }), previous: stats({ count: 12 }), earlier: 4 }), WINDOW)
    ).toBeUndefined();
  });
});

describe("evaluateTelemetryAnomalies 汇总与排序", () => {
  it("跑完全部规则并按 严重度 → 规则 → 事件名 稳定排序", () => {
    const found = evaluateTelemetryAnomalies({
      window: WINDOW,
      names: [
        // 错误码新、失败率高（error），同时会命中 failure-rate-spike 与 new-error-code。
        entry({
          name: "canvas.open",
          current: stats({
            count: 20,
            failures: 12,
            errorCodes: [{ code: "brand-new-code", count: 2, firstSeenAt: 1 }]
          }),
          previous: stats({ count: 20, failures: 0 })
        }),
        // 静默：只在基线窗口存在（调用方把并集名喂进来）。
        entry({ name: "canvas.save", current: stats({ count: 0 }), previous: stats({ count: 10 }), earlier: 10 })
      ],
      previouslySeenErrorCodes: new Set<string>()
    });

    expect(found.map((anomaly) => `${anomaly.severity}:${anomaly.ruleId}:${anomaly.name}`)).toEqual([
      "error:failure-rate-spike:canvas.open",
      "warn:event-silence:canvas.save",
      "warn:new-error-code:canvas.open"
    ]);
  });

  it("同一规则、同一严重度时按事件名排序", () => {
    const found = evaluateTelemetryAnomalies({
      window: WINDOW,
      names: [
        entry({ name: "sync.connect", current: stats({ count: 0 }), previous: stats({ count: 5 }), earlier: 5 }),
        entry({ name: "canvas.edit", current: stats({ count: 0 }), previous: stats({ count: 5 }), earlier: 5 })
      ],
      previouslySeenErrorCodes: new Set<string>()
    });

    expect(found.map((anomaly) => anomaly.name)).toEqual(["canvas.edit", "sync.connect"]);
  });

  it("previouslySeenErrorCodes 会压掉 new-error-code，但不影响其它规则", () => {
    const found = evaluateTelemetryAnomalies({
      window: WINDOW,
      names: [
        entry({
          name: "canvas.open",
          current: stats({ count: 20, failures: 5, errorCodes: [{ code: "known", count: 1, firstSeenAt: 1 }] })
        })
      ],
      previouslySeenErrorCodes: new Set(["known"])
    });

    expect(found.map((anomaly) => anomaly.ruleId)).toEqual(["failure-rate-spike"]);
  });

  it("没有命中时返回空数组", () => {
    expect(
      evaluateTelemetryAnomalies({
        window: WINDOW,
        names: [entry({ current: stats({ count: 3 }) })],
        previouslySeenErrorCodes: new Set<string>()
      })
    ).toEqual([]);
  });

  it("比率保留 4 位小数，避免证据出现浮点长尾", () => {
    const hit = detectFailureRateSpike(
      entry({ current: stats({ count: 3 * 10, failures: 10 }) }),
      WINDOW
    );
    expect(hit?.observed).toBe(0.3333);
    expect(hit?.evidence.currentRate).toBe(0.3333);
  });

  it("规则顺序常量覆盖四条规则且顺序稳定", () => {
    expect(TELEMETRY_ANOMALY_RULE_ORDER).toEqual([
      "failure-rate-spike",
      "new-error-code",
      "latency-regression",
      "event-silence"
    ]);
  });
});
