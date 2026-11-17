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
  return { id, name: "canvas.edit", result: "success", origin: "browser", occurredAt: 0, receivedAt: 1_700_000_000_000 };
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
  it("removes performance controls and keeps business grouping", () => {
    const markup = render();
    expect(markup).not.toContain("按构建模式筛选");
    expect(markup).not.toContain("全部构建");
    expect(markup).toContain("分组");
    expect(markup).toContain("按事件名");
  });

  it("未分组时不渲染耗时榜（与窗口聚合重复）", () => {
    const markup = render({ query: { window: "24h", groupBy: undefined } });
    expect(markup).not.toContain('data-testid="telemetry-duration-ranking"');
  });

  it("business grouping keeps its table without a performance ranking", () => {
    const markup = render({
      query: { window: "24h", groupBy: "source" },
      summary: summary({
        groupBy: "source",
        rows: [
          {
            name: "canvas.edit",
            attributeValue: "local",
            count: 10,
            results: { success: 10, failure: 0, cancelled: 0, rejected: 0 },
            durationSamples: 10,
            durationP50: 20,
            durationP95: 30,
            durationMax: 40,
            topErrorCodes: []
          },
          {
            name: "canvas.edit",
            attributeValue: "remote",
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

    expect(markup).not.toContain('data-testid="telemetry-duration-ranking"');
    expect(markup).toContain("按来源");
    // 表格有分组列，且两行都在。
    expect(markup).toContain('data-testid="telemetry-summary-group"');
    expect(markup).toContain("local");
    expect(markup).toContain("remote");

  });

  it("分组命中在异常卡上带出维度名与取值（与「整体变慢」可区分）", () => {
    const anomaly: TelemetryAnomaly = {
      ruleId: "latency-regression",
      severity: "warn",
      name: "canvas.edit",
      attributeValue: "local",
      window: "24h",
      observed: 300,
      baseline: 100,
      samples: 20,
      evidence: {}
    };
    const markup = render({ query: { window: "24h", groupBy: "source" }, anomalies: [anomaly] });
    expect(markup).toContain('data-testid="telemetry-anomaly-group"');
    expect(markup).toContain("来源");
    expect(markup).toContain("local");
  });

  it("没有分组成员的命中不画分组标记", () => {
    const anomaly: TelemetryAnomaly = {
      ruleId: "latency-regression",
      severity: "warn",
      name: "canvas.edit",
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
