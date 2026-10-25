/**
 * 复盘页派生逻辑测试（change: 2026-10-20-add-local-client-telemetry）。
 *
 * 重点守「开关开着但发不出去」的两种成因：它们长得像同一个问题，修法却完全不同——
 * - 没有任何出口 → 用户要去看「服务端接入」扩展是否启用；
 * - 出口在但不可用 → 用户要去连接服务端。
 * 把两者合并成一句"上报异常"就等于让用户去猜。
 */
import { describe, expect, it } from "vitest";
import type { TelemetryExportStatus, TelemetryStatus, TelemetrySummaryRow } from "@woohaa3/contracts";
import { rankByDuration, resolveTelemetryViewState, sortSummaryRows, telemetryNotices } from "./model.js";

function status(overrides: Partial<TelemetryStatus> = {}): TelemetryStatus {
  return {
    enabled: true,
    exportEnabled: false,
    store: "ok",
    storePath: "/tmp/telemetry.sqlite",
    queued: 0,
    droppedInvalid: 0,
    droppedOverflow: 0,
    writeErrors: 0,
    eventCount: 1,
    bytes: 1024,
    exports: [],
    ...overrides
  } as TelemetryStatus;
}

function provider(overrides: Partial<TelemetryExportStatus> = {}): TelemetryExportStatus {
  return { exportId: "remote", label: "服务端接入", available: true, dropped: 0, ...overrides };
}

describe("顶部提示", () => {
  it("没有状态时不提示", () => {
    expect(telemetryNotices(null)).toEqual([]);
  });

  it("上报关闭时不提示任何上报相关内容", () => {
    expect(telemetryNotices(status({ exportEnabled: false, exports: [] }))).toEqual([]);
  });

  it("开关开着但没有注册任何出口 → 指向扩展是否启用", () => {
    const notices = telemetryNotices(status({ exportEnabled: true, exports: [] }));
    expect(notices).toEqual([{ kind: "export-unrouted", reason: "no-export" }]);
  });

  it("出口都在但都不可用 → 提示未连接/未登录", () => {
    const notices = telemetryNotices(
      status({ exportEnabled: true, exports: [provider({ available: false }), provider({ available: false })] })
    );
    expect(notices).toEqual([{ kind: "export-unrouted", reason: "no-provider-available" }]);
  });

  it("有一个出口可用就算正常上报（不因另一个不可用而报异常）", () => {
    const notices = telemetryNotices(
      status({ exportEnabled: true, exports: [provider({ available: false }), provider({ available: true })] })
    );
    expect(notices).toEqual([{ kind: "export-enabled", destinations: ["服务端接入", "服务端接入"] }]);
  });

  it("出口没有 label 时用 exportId 作目的地名", () => {
    const notices = telemetryNotices(
      status({ exportEnabled: true, exports: [{ exportId: "remote", available: true, dropped: 0 }] })
    );
    expect(notices).toEqual([{ kind: "export-enabled", destinations: ["remote"] }]);
  });

  it("丢弃与上报提示同时出现（互不吞掉）", () => {
    const notices = telemetryNotices(
      status({ exportEnabled: true, exports: [provider()], droppedOverflow: 3, droppedInvalid: 2 })
    );
    expect(notices.map((notice) => notice.kind)).toEqual(["export-enabled", "dropped"]);
  });
});

describe("视图状态", () => {
  it("存储不可用优先于记录已关闭（故障要给人路径，关闭是用户自己选的）", () => {
    expect(
      resolveTelemetryViewState({
        status: status({ enabled: false, store: "unavailable", storePath: "/tmp/x.sqlite" }),
        hasEvents: false,
        filtered: false
      })
    ).toEqual({ kind: "store-unavailable", storePath: "/tmp/x.sqlite" });
  });

  it("记录关闭但不处于故障 → disabled", () => {
    expect(
      resolveTelemetryViewState({ status: status({ enabled: false }), hasEvents: false, filtered: false })
    ).toEqual({ kind: "disabled" });
  });

  it("首次加载中不显示空态（否则会误报「还没有记录」）", () => {
    expect(
      resolveTelemetryViewState({ status: status(), loading: true, hasEvents: false, filtered: false })
    ).toEqual({ kind: "loading" });
  });

  it("空态区分「没记录」与「没匹配条件」", () => {
    expect(
      resolveTelemetryViewState({ status: status(), hasEvents: false, filtered: false })
    ).toEqual({ kind: "empty", filtered: false });
    expect(resolveTelemetryViewState({ status: status(), hasEvents: false, filtered: true })).toEqual({
      kind: "empty",
      filtered: true
    });
  });

  it("读取失败即服务不可用，且带安全文案", () => {
    expect(
      resolveTelemetryViewState({
        status: null,
        statusError: "读取本机遥测失败",
        hasEvents: false,
        filtered: false
      })
    ).toEqual({ kind: "service-unavailable", message: "读取本机遥测失败" });
  });
});

/**
 * 分组耗时榜的排序口径
 * （change: 2026-10-25-enhance-telemetry-performance-collection，任务 4.3 / design D5）。
 *
 * 两条边界最容易被写错，各有一条用例：
 * 1. 缺 p95 的组**排最后**而不是当 0ms——把"没测到"排在"很快"前面会让人以为它最快；
 * 2. 同 p95 时排序要稳定（事件名 → 分组值），否则每次刷新行序跳动。
 */
function row(overrides: Partial<TelemetrySummaryRow> & Pick<TelemetrySummaryRow, "name">): TelemetrySummaryRow {
  return {
    count: 10,
    results: { success: 10, failure: 0, cancelled: 0, rejected: 0 },
    durationSamples: 10,
    topErrorCodes: [],
    ...overrides
  } as TelemetrySummaryRow;
}

describe("分组耗时榜", () => {
  it("按 p95 降序排列，缺样本的组排在最后", () => {
    const rows = rankByDuration([
      row({ name: "perf.interaction", attributeValue: "zoom", durationP95: 12, durationP50: 8 }),
      row({ name: "perf.interaction", attributeValue: "pan" }),
      row({ name: "perf.interaction", attributeValue: "drag", durationP95: 40, durationP50: 30 })
    ]);
    expect(rows.map((entry) => entry.attributeValue)).toEqual(["drag", "zoom", "pan"]);
  });

  it("同 p95 时按事件名、再按分组值稳定排序", () => {
    const rows = rankByDuration([
      row({ name: "perf.segment", attributeValue: "b", durationP95: 20 }),
      row({ name: "perf.interaction", attributeValue: "z", durationP95: 20 }),
      row({ name: "perf.interaction", attributeValue: "a", durationP95: 20 })
    ]);
    expect(rows.map((entry) => `${entry.name}:${entry.attributeValue}`)).toEqual([
      "perf.interaction:a",
      "perf.interaction:z",
      "perf.segment:b"
    ]);
  });

  it("聚合表同计数时按事件名与分组值排序（不依赖 SQL 返回顺序）", () => {
    const rows = sortSummaryRows([
      row({ name: "perf.interaction", attributeValue: "pan", count: 3 }),
      row({ name: "canvas.save", count: 3 }),
      row({ name: "perf.interaction", attributeValue: "drag", count: 3 })
    ]);
    expect(rows.map((entry) => `${entry.name}:${entry.attributeValue ?? ""}`)).toEqual([
      "canvas.save:",
      "perf.interaction:drag",
      "perf.interaction:pan"
    ]);
  });
});
