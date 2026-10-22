/**
 * 遥测复盘页的「异常概览」与「窗口聚合」
 * （change: 2026-10-20-add-local-client-telemetry，任务 5.2 / design D5/D6/D9）。
 *
 * 两个面板都只消费契约类型，不含取数逻辑：
 * - **异常概览**：规则命中按严重度排序，每条都给出「观测值 vs 基线值 + 样本数」——没有样本数的
 *   百分比是解读陷阱（design D6），所以样本数与数值同列；
 * - **窗口聚合**：每个事件名一行（计数/失败率/p50/p95/max/高频错误码），另加按分桶的计数趋势。
 *   趋势用轻量条状行列表而不是图表库：复盘需要的是"哪几个桶高"，不是可交互图表。
 */
import type {
  TelemetryAnomaly,
  TelemetryStatus,
  TelemetrySummary,
  TelemetryWindow
} from "@woohaa3/contracts";
import {
  BUCKET_LABELS,
  WINDOW_LABELS,
  eventNameLabel,
  formatAnomalyValue,
  formatBytes,
  formatCount,
  formatDuration,
  formatPercent,
  ratioToMax,
  resultLabel,
  ruleLabel,
  severityLabel
} from "./format.js";
import {
  bucketPeak,
  bucketTotals,
  failureRate,
  isEmptySummary,
  sortAnomalies,
  sortSummaryRows,
  type TelemetryNotice
} from "./model.js";

/** 顶部提示条：导出开启（不静默外发）与丢弃/写失败（数据有缺口）。 */
export function TelemetryNotices({ notices }: { notices: readonly TelemetryNotice[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="telemetry__notices">
      {notices.map((notice) =>
        notice.kind === "export-enabled" ? (
          <p key="export" className="telemetry__notice is-export" role="status" data-testid="telemetry-notice-export">
            当前已开启外部上报：本机事件会被发送到
            {notice.destinations.length > 0 ? ` ${notice.destinations.join("、")}` : "已注册的出口"}。
            关闭开关后才会完全留在本机。
          </p>
        ) : notice.kind === "export-unrouted" ? (
          // 开关开着但发不出去：这是「开了没反应」的现场，必须直接说清成因与下一步。
          <p
            key="export-unrouted"
            className="telemetry__notice is-export-unrouted"
            role="status"
            data-testid="telemetry-notice-export-unrouted"
            data-reason={notice.reason}
          >
            {notice.reason === "no-export"
              ? "已开启外部上报，但当前没有任何上报出口——事件仍只留在本机。上报出口由「服务端接入」扩展在激活时注册，检查该扩展是否已启用。"
              : "已开启外部上报，但上报出口当前不可用（未连接服务端或未登录）——事件仍只留在本机。连接服务端后会自动开始上报。"}
          </p>
        ) : (
          <p key="dropped" className="telemetry__notice is-dropped" role="status" data-testid="telemetry-notice-dropped">
            记录有缺口：
            {notice.droppedOverflow > 0 ? ` 队列溢出丢弃 ${formatCount(notice.droppedOverflow)} 条；` : ""}
            {notice.droppedInvalid > 0 ? ` 非法事件丢弃 ${formatCount(notice.droppedInvalid)} 条；` : ""}
            {notice.writeErrors > 0 ? ` 写入失败 ${formatCount(notice.writeErrors)} 次；` : ""}
            {notice.queued > 0 ? ` 当前排队待写 ${formatCount(notice.queued)} 条。` : ""}
            复盘时这些条数不可回溯。
          </p>
        )
      )}
    </div>
  );
}

/** 异常概览：按严重度（error→warn→info）排序的卡片；空态明确说"规则没命中"。 */
export function AnomalyOverview({
  anomalies,
  window,
  testId = "telemetry-anomalies"
}: {
  anomalies: readonly TelemetryAnomaly[];
  window: TelemetryWindow;
  testId?: string;
}) {
  const sorted = sortAnomalies(anomalies);
  return (
    <section className="telemetry__section" data-testid={testId}>
      <header className="telemetry__section-head">
        <h2>异常概览</h2>
        <span className="telemetry__section-hint">{WINDOW_LABELS[window]}</span>
      </header>
      {sorted.length === 0 ? (
        <p className="telemetry__empty" data-testid="telemetry-anomalies-empty">
          当前窗口没有命中规则。规则只在样本足够且与基线有明确差异时才报（只呈现，不拦截任何操作）。
        </p>
      ) : (
        <ul className="telemetry__anomalies">
          {sorted.map((anomaly, index) => (
            <li
              key={`${anomaly.ruleId}:${anomaly.name}:${index}`}
              className={`telemetry__anomaly is-${anomaly.severity}`}
              data-testid="telemetry-anomaly"
              data-severity={anomaly.severity}
            >
              <div className="telemetry__anomaly-head">
                <span className="telemetry__severity">{severityLabel(anomaly.severity)}</span>
                <span className="telemetry__anomaly-rule">{ruleLabel(anomaly.ruleId)}</span>
                <span className="telemetry__anomaly-name">{eventNameLabel(anomaly.name)}</span>
              </div>
              <dl className="telemetry__anomaly-metrics">
                <div>
                  <dt>观测值</dt>
                  <dd>{formatAnomalyValue(anomaly.ruleId, anomaly.observed)}</dd>
                </div>
                <div>
                  <dt>基线值</dt>
                  <dd>{formatAnomalyValue(anomaly.ruleId, anomaly.baseline)}</dd>
                </div>
                <div>
                  <dt>样本数</dt>
                  <dd>{formatCount(anomaly.samples)}</dd>
                </div>
              </dl>
              <p className="telemetry__anomaly-rule-id">规则 {anomaly.ruleId}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 窗口聚合表：每行一个事件名；失败率与分位数同列，便于"哪里变慢/哪里在错"一眼对照。 */
export function WindowSummaryTable({ summary }: { summary: TelemetrySummary | null }) {
  const rows = summary ? sortSummaryRows(summary.rows) : [];
  return (
    <section className="telemetry__section" data-testid="telemetry-summary">
      <header className="telemetry__section-head">
        <h2>窗口聚合</h2>
        <span className="telemetry__section-hint">
          {summary ? `${summary.window} · ${BUCKET_LABELS[summary.bucket]} · 共 ${formatCount(summary.total)} 条` : "尚未读取"}
        </span>
      </header>
      {isEmptySummary(rows) ? (
        <p className="telemetry__empty" data-testid="telemetry-summary-empty">
          当前窗口没有聚合数据。
        </p>
      ) : (
        <div className="telemetry__table-wrap">
          <table className="telemetry__table">
            <caption className="visually-hidden">按事件名的窗口聚合</caption>
            <thead>
              <tr>
                <th scope="col">事件</th>
                <th scope="col">计数</th>
                <th scope="col">失败率</th>
                <th scope="col">p50</th>
                <th scope="col">p95</th>
                <th scope="col">max</th>
                <th scope="col">结果分布</th>
                <th scope="col">高频错误码</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name} data-testid="telemetry-summary-row">
                  <th scope="row">{eventNameLabel(row.name)}</th>
                  <td>{formatCount(row.count)}</td>
                  <td>{formatPercent(failureRate(row))}</td>
                  <td>{formatDuration(row.durationP50)}</td>
                  <td>{formatDuration(row.durationP95)}</td>
                  <td>{formatDuration(row.durationMax)}</td>
                  <td className="telemetry__cell-results">
                    {(["success", "failure", "cancelled", "rejected"] as const)
                      .map((result) => `${resultLabel(result)} ${formatCount(row.results[result] ?? 0)}`)
                      .join(" · ")}
                  </td>
                  <td>
                    {row.topErrorCodes.length === 0 ? (
                      "—"
                    ) : (
                      <ul className="telemetry__codes">
                        {row.topErrorCodes.map((entry) => (
                          <li key={entry.code}>
                            <code>{entry.code}</code>
                            <span>{formatCount(entry.count)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * 按分桶的计数趋势。
 *
 * 用"每桶一行 + 相对宽度条"表达，而不是引入图表库：本页只回答"哪几个桶高、失败是否集中"，
 * 行列表还能被复制、被读屏念出来，也不会为一屏数据多背一个依赖。
 */
export function CountTrend({ summary }: { summary: TelemetrySummary | null }) {
  const points = summary ? bucketTotals(summary.series) : [];
  const peak = bucketPeak(points);
  return (
    <section className="telemetry__section" data-testid="telemetry-trend">
      <header className="telemetry__section-head">
        <h2>计数趋势</h2>
        <span className="telemetry__section-hint">{summary ? `${points.length} 个时间桶` : "尚未读取"}</span>
      </header>
      {points.length === 0 ? (
        <p className="telemetry__empty" data-testid="telemetry-trend-empty">
          当前窗口没有时间序列。
        </p>
      ) : (
        <ul className="telemetry__trend">
          {points.map((point) => (
            <li key={point.at} className="telemetry__trend-row" data-testid="telemetry-trend-row">
              <span className="telemetry__trend-time">{new Date(point.at).toLocaleString()}</span>
              <span
                className="telemetry__trend-bar is-count"
                style={{ width: `${Math.round(ratioToMax(point.count, peak) * 100)}%` }}
                aria-hidden="true"
              />
              <span className="telemetry__trend-value">
                {formatCount(point.count)} 条
                {point.failures > 0 ? ` · 失败 ${formatCount(point.failures)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 页脚一行口径：事件数与数据库占用（复盘时也要知道自己看的范围有多大）。 */
export function TelemetryFooter({ status }: { status: TelemetryStatus | null }) {
  if (!status) return null;
  return (
    <footer className="telemetry__footer" data-testid="telemetry-footer">
      <span>已落库 {formatCount(status.eventCount)} 条</span>
      <span>数据库占用 {formatBytes(status.bytes)}</span>
      {status.storePath ? <span className="telemetry__path">文件 {status.storePath}</span> : null}
    </footer>
  );
}
