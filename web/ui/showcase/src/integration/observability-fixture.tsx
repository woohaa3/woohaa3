import { useMemo, useState } from "react";
import { TASK_EXECUTION_STATES, type TaskExecutionState, type TaskHistoryQuery, type TelemetryStatus } from "@woohaa3/contracts";
import { TaskMonitorPage } from "../../../../frontend/src/pages/task-monitor/task-monitor.js";
import type { TaskMonitorRemote } from "../../../../frontend/src/pages/task-monitor/remote.js";
import { TelemetryPage } from "../../../../frontend/src/pages/telemetry/telemetry-page.js";
import type { TelemetryQuery } from "../../../../frontend/src/pages/telemetry/query.js";
import { TASK_HISTORY_FIXTURES, fixtureMediaUrl } from "../task-history-fixtures.js";
import { Button } from "@woohaa3/ui/primitives";
import { IntegrationStage, PendingActions, ScenarioPicker, useRecorder, type Scenario } from "./memory.js";
export function MonitorIntegration() {
  const [scenario, setScenario] = useState<Scenario>("ready"); const { record, log } = useRecorder();
  const [query, setQuery] = useState<TaskHistoryQuery>({}); const [selected, select] = useState<string>(); const [revision, change] = useState(0);
  const fixture = useMemo(() => {
    let failure = scenario === "error", hold = scenario === "loading"; const waiting: Array<() => void> = [];
    const remote: TaskMonitorRemote = {
      async snapshot(input) {
        record("监控查询"); if (hold) await new Promise<void>(resolve => waiting.push(resolve));
        if (failure) { failure = false; return { ok: false, code: "unavailable", error: "监控暂不可用，请重试" }; }
        const items = scenario === "empty" ? [] : TASK_HISTORY_FIXTURES.filter(row => !input.query?.state || row.state === input.query.state);
        const counts = Object.fromEntries(TASK_EXECUTION_STATES.map(state => [state, items.filter(row => row.state === state).length])) as Record<TaskExecutionState, number>;
        return { ok: true, value: { observedAt: "2026-10-28T08:00:00Z", stateCounts: counts, items, nextCursor: null } };
      },
      async detail({ taskKey }) { record(`详情 ${taskKey}`); const detail = TASK_HISTORY_FIXTURES.find(row => row.taskKey === taskKey); return detail ? { ok: true, value: detail } : { ok: false, code: "not-found", error: "详情已失效" }; }
    };
    return { remote, settle: () => { hold = false; waiting.splice(0).forEach(resolve => resolve()); record("完成监控读取"); } };
  }, [scenario, revision]);
  return <IntegrationStage title="任务监控">
    <ScenarioPicker value={scenario} onChange={setScenario} /><PendingActions settle={fixture.settle} /><Button onClick={() => { change(v => v + 1); record("更新任务快照"); }}>更新快照</Button>
    <div style={{ height: 650, position: "relative" }}><TaskMonitorPage remote={fixture.remote} appliedQuery={query} selectedTaskKey={selected} pollIntervalMs={60_000}
      onQueryChange={next => { setQuery(next.query); select(next.taskKey); record("筛选 / 选择"); }} onOpenCanvas={input => record(`画布 ${input.canvasId}`)} resolveMediaUrl={fixtureMediaUrl} /></div>{log}
  </IntegrationStage>;
}
export function TelemetryIntegration() {
  const [scenario, select] = useState<Scenario>("ready"); const [enabled, enable] = useState(true); const [query, setQuery] = useState<TelemetryQuery>({ window: "24h" });
  const [errorCode, setErrorCode] = useState<string>(); const [more, loadMore] = useState(false); const { record, log } = useRecorder();
  const status: TelemetryStatus = { enabled, exportEnabled: false, store: "ok", storePath: "/fixture/telemetry", queued: 0, droppedInvalid: 0, droppedOverflow: 0, writeErrors: 0, eventCount: scenario === "empty" ? 0 : 2, bytes: 1024, exports: [] };
  const events = scenario === "empty" ? [] : [1, ...(more ? [2] : [])].map(id => ({ id, name: "perf.interaction" as const, result: "success" as const, origin: "browser" as const, occurredAt: 1_792_905_600_000, receivedAt: 1_792_905_600_001 }));
  return <IntegrationStage title="本机遥测">
    <ScenarioPicker value={scenario} onChange={select} /><Button onClick={() => { enable(!enabled); record("切换采集"); }}>采集开 / 关</Button>
    <TelemetryPage query={query} errorCode={errorCode} status={scenario === "loading" ? null : status} statusError={scenario === "error" ? "遥测服务暂不可用" : null}
      summary={{ window: "24h", bucket: "1h", since: 0, until: 1_792_905_600_000, total: events.length, rows: [], series: [] }} anomalies={[]} events={events} loading={scenario === "loading"} eventsLoading={false}
      nextCursor={more ? undefined : "next"} onChangeQuery={next => { setQuery(next); record("应用筛选"); }} onErrorCodeChange={v => { setErrorCode(v); record("错误码筛选"); }}
      onRefresh={() => { select("ready"); record("刷新恢复"); }} onLoadMore={() => { loadMore(true); record("加载更多"); }} onBack={() => record("返回画布")} onOpenSettings={() => { enable(true); record("开启采集"); }} />{log}
  </IntegrationStage>;
}
