/**
 * 复盘页渲染测试（change: 2026-10-25-enhance-telemetry-performance-collection，任务 4.3）。
 *
 * 用 `react-dom/server` 静态渲染（无 DOM）：只验证「页面上真的出现了新控件与新面板」，
 * 以及几条容易写反的口径——分组列只在分组时出现、耗时榜按 p95 排序、异常命中带出分组维度。
 * 取数与 URL 编解码由 `remote`/`query`/`model` 的单测覆盖，这里不重复。
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TelemetryAnomaly, TelemetryEventRecord, TelemetryStatus, TelemetrySummary } from "@woohaa3/contracts";
import { TelemetryPage, type TelemetryPageProps } from "./telemetry-page.js";
import type { TelemetryQuery } from "./query.js";

function status(): TelemetryStatus {
  return {
    enabled: true,
    exportEnabled: false,
    store: "ok",
    storePath: "/tmp/telemetry.sqlite",
    queued: 0,
    droppedInvalid: 0,
    droppedOverflow: 0,
    writeErrors: 0,
    eventCount: 4,
    bytes: 2048,
    exports: []
  };
}

function event(id: number): TelemetryEventRecord {
  return { id, name: "perf.interaction", result: "success", origin: "browser", occurredAt: 0, receivedAt: 1_700_000_000_000 };
}

function summary(overrides: Partial<TelemetrySummary> = {}): TelemetrySummary {
  return {
    window: "24h",
    bucket: "1h",
    since: 0,
    until: 1,
    total: 4,
    rows: [],
    series: [],
    ...overrides
  };
}

function render(overrides: Partial<TelemetryPageProps> & { query?: TelemetryQuery } = {}): string {
  const props: TelemetryPageProps = {
    query: overrides.query ?? { window: "24h" },
    status: status(),
    summary: summary(),
    anomalies: [],
    events: [event(1)],
    loading: false,
    eventsLoading: false,
    onChangeQuery: vi.fn(),
    onErrorCodeChange: vi.fn(),
    onRefresh: vi.fn(),
    onLoadMore: vi.fn(),
    onBack: vi.fn(),
    ...overrides
  };
  return renderToStaticMarkup(<TelemetryPage {...props} />);
}

describe("复盘页的分组与构建模式", () => {
  it("筛选栏始终提供构建模式与分组两个选择器", () => {
    const markup = render();
    expect(markup).toContain("构建模式");
    expect(markup).toContain("按构建模式筛选");
    // 缺省值是"全部构建"/"按事件名"：下拉是 listbox，选项在弹层里，SSR 只出当前值。
    expect(markup).toContain("全部构建");
    expect(markup).toContain("分组");
    expect(markup).toContain("按事件名");
  });

  it("选中的构建模式与分组回显在筛选栏上", () => {
    const markup = render({ query: { window: "24h", mode: "production", groupBy: "kind" } });
    expect(markup).toContain("发布构建");
    expect(markup).toContain("按输入种类");
  });

  it("未分组时不渲染耗时榜（与窗口聚合重复）", () => {
    const markup = render({ query: { window: "24h", groupBy: undefined } });
    expect(markup).not.toContain('data-testid="telemetry-duration-ranking"');
  });

  it("分组时聚合表多出分组列，并按 p95 给出耗时榜", () => {
    const markup = render({
      query: { window: "24h", groupBy: "kind" },
      summary: summary({
        groupBy: "kind",
        rows: [
          {
            name: "perf.interaction",
            attributeValue: "pan",
            count: 10,
            results: { success: 10, failure: 0, cancelled: 0, rejected: 0 },
            durationSamples: 10,
            durationP50: 20,
            durationP95: 30,
            durationMax: 40,
            topErrorCodes: []
          },
          {
            name: "perf.interaction",
            attributeValue: "zoom",
            count: 10,
            results: { success: 10, failure: 0, cancelled: 0, rejected: 0 },
            durationSamples: 10,
            durationP50: 5,
            durationP95: 8,
            durationMax: 9,
            topErrorCodes: []
          }
        ]
      })
    });

    expect(markup).toContain('data-testid="telemetry-duration-ranking"');
    expect(markup).toContain("按输入种类");
    // 表格有分组列，且两行都在。
    expect(markup).toContain('data-testid="telemetry-summary-group"');
    expect(markup).toContain("pan");
    expect(markup).toContain("zoom");

    // 耗时榜按 p95 降序：pan（30ms）在 zoom（8ms）之前。
    const ranking = markup.slice(markup.indexOf('data-testid="telemetry-duration-ranking"'));
    expect(ranking.indexOf("pan")).toBeLessThan(ranking.indexOf("zoom"));
  });

  it("分组命中在异常卡上带出维度名与取值（与「整体变慢」可区分）", () => {
    const anomaly: TelemetryAnomaly = {
      ruleId: "latency-regression",
      severity: "warn",
      name: "perf.interaction",
      attributeValue: "pan",
      window: "24h",
      observed: 300,
      baseline: 100,
      samples: 20,
      evidence: {}
    };
    const markup = render({ query: { window: "24h", groupBy: "kind" }, anomalies: [anomaly] });
    expect(markup).toContain('data-testid="telemetry-anomaly-group"');
    expect(markup).toContain("输入种类");
    expect(markup).toContain("pan");
  });

  it("没有分组成员的命中不画分组标记", () => {
    const anomaly: TelemetryAnomaly = {
      ruleId: "latency-regression",
      severity: "warn",
      name: "perf.interaction",
      window: "24h",
      observed: 300,
      baseline: 100,
      samples: 20,
      evidence: {}
    };
    const markup = render({ anomalies: [anomaly] });
    expect(markup).not.toContain('data-testid="telemetry-anomaly-group"');
  });
});
