/**
 * `/telemetry` 页面的适配组件（change: 2026-10-20-add-local-client-telemetry，任务 5.3）。
 *
 * **单独一个文件是为了首屏体积**：`plugins/telemetry/plugin.tsx` 里的插件对象会被
 * `cordis/manifest.ts` 静态引入（页面清单需要插件函数本体），所以插件文件只能留槽位注册。
 * 一旦在插件文件里静态引入取数层（`remote`/`model`/`query`）与页面，它们就会进入**入口静态闭包**，
 * 让每个用户都在启动时下载复盘页代码。把整段适配逻辑放到这个模块里、由插件
 * 动态 import，本模块与页面就只落在复盘页自己的 chunk 中。
 *
 * 职责边界不变：本组件只做适配（订阅 App Router、调宿主同源 API、把纯数据交给页面组件），
 * 不创建 Canvas Session / sync socket / Bevy，不自行 fetch（走 scope 里的 `applicationRemote`）。
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { TelemetryAnomaly, TelemetryEventRecord, TelemetryStatus, TelemetrySummary } from "@woohaa3/contracts";
import type { AppRouterService, AppTelemetryQuery } from "../../navigation/app-router.js";
import { DEFAULT_TELEMETRY_WINDOW, type TelemetryQuery } from "../../../pages/telemetry/query.js";
import { mergeEventPage } from "../../../pages/telemetry/model.js";
import { createTelemetryRemote, telemetryErrorText, type TelemetryTransport } from "../../../pages/telemetry/remote.js";

const TelemetryPage = lazy(() =>
  import("../../../pages/telemetry/telemetry-page.js").then((module) => ({ default: module.TelemetryPage }))
);

/** 类型化 location → 页面查询（缺失字段落回缺省窗口）。 */
function queryFromLocation(query: AppTelemetryQuery | undefined): TelemetryQuery {
  return {
    window: query?.window ?? DEFAULT_TELEMETRY_WINDOW,
    ...(query?.name ? { name: query.name } : {}),
    ...(query?.result ? { result: query.result } : {}),
    ...(query?.mode ? { mode: query.mode } : {}),
    ...(query?.groupBy ? { groupBy: query.groupBy } : {}),
    ...(query?.cursor ? { cursor: query.cursor } : {}),
    ...(query?.eventId ? { eventId: query.eventId } : {}),
    ...(query?.canvasId ? { canvasId: query.canvasId } : {})
  };
}

/** 页面控制器：订阅 App Router、接宿主 API，把纯数据交给 `TelemetryPage`。 */
export function TelemetryRoute({
  router,
  transport,
  onOpenSettings
}: {
  router: AppRouterService;
  /** 当前 scope 的同源传输（由插件从 `applicationRemote` 取，避免在这里第二次解析）。 */
  transport: TelemetryTransport;
  onOpenSettings: () => void;
}) {
  const location = useSyncExternalStore(router.subscribe, router.getLocation, router.getLocation);
  const query = queryFromLocation(location.page === "telemetry" ? location.telemetry : undefined);
  const appliedKey = JSON.stringify(query);
  const [errorCode, setErrorCode] = useState<string | undefined>(undefined);

  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [summary, setSummary] = useState<TelemetrySummary | null>(null);
  const [anomalies, setAnomalies] = useState<readonly TelemetryAnomaly[]>([]);
  const [events, setEvents] = useState<readonly TelemetryEventRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);

  const remote = useMemo(() => createTelemetryRemote({ transport }), [transport]);
  const generation = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setEventsError(null);

    const { window, name, result, mode, groupBy, cursor } = query;
    const [statusOutcome, summaryOutcome, anomaliesOutcome, eventsOutcome] = await Promise.all([
      remote.status({ signal: controller.signal }),
      remote.summary({
        window,
        ...(mode ? { mode } : {}),
        ...(groupBy ? { groupBy } : {}),
        signal: controller.signal
      }),
      remote.anomalies({ window, ...(groupBy ? { groupBy } : {}), signal: controller.signal }),
      remote.events({
        window,
        ...(name ? { name } : {}),
        ...(result ? { result } : {}),
        ...(mode ? { mode } : {}),
        ...(errorCode ? { errorCode } : {}),
        ...(cursor ? { cursor } : {})
      })
    ]);
    // 过期响应（已切筛选/已离开页面）一律丢弃，不覆盖新结果。
    if (gen !== generation.current) return;
    setLoading(false);

    if (!statusOutcome.ok) {
      if (statusOutcome.code === "aborted") return;
      setStatus(null);
      setStatusError(telemetryErrorText(statusOutcome.code, statusOutcome.error, "status"));
      return;
    }
    setStatus(statusOutcome.value);
    setStatusError(null);
    // 聚合/异常失败不拖垮整页：列表与状态仍可读，聚合显示为空。
    setSummary(summaryOutcome.ok ? summaryOutcome.value : null);
    setAnomalies(anomaliesOutcome.ok ? anomaliesOutcome.value : []);
    if (eventsOutcome.ok) {
      setEvents(eventsOutcome.value.events);
      setNextCursor(eventsOutcome.value.nextCursor);
    } else {
      setEvents([]);
      setNextCursor(undefined);
      setEventsError(telemetryErrorText(eventsOutcome.code, eventsOutcome.error, "events"));
    }
  }, [remote, appliedKey, errorCode]);

  // 查询（窗口/事件名/结果/错误码/游标）变化即重取；首次挂载也算一次。
  useEffect(() => {
    void load();
    return () => controllerRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedKey, errorCode, load]);

  const changeQuery = useCallback(
    (next: TelemetryQuery, options?: { replace?: boolean }) => {
      const target = { page: "telemetry" as const, telemetry: { ...next } };
      if (options?.replace) router.replace(target);
      else router.navigate(target);
    },
    [router]
  );

  // 返回画布：目标由 URL 的 `canvasId` 决定（从设置进来时带的是用户当时那张画布）；
  // 直接打开 `/telemetry` 时没有它，就回默认画布。放在这里而不是插件文件里，是为了让插件保持
  // 只做槽位注册（入口静态闭包预算，见该文件头注释）。
  const onBack = useCallback(() => {
    router.navigate({ page: "canvas", ...(query.canvasId ? { canvasId: query.canvasId } : {}) });
  }, [router, query.canvasId]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || eventsLoading) return;
    setEventsLoading(true);
    setEventsError(null);
    const outcome = await remote.events({
      window: query.window,
      ...(query.name ? { name: query.name } : {}),
      ...(query.result ? { result: query.result } : {}),
      ...(query.mode ? { mode: query.mode } : {}),
      ...(errorCode ? { errorCode } : {}),
      cursor: nextCursor
    });
    setEventsLoading(false);
    if (!outcome.ok) {
      setEventsError(telemetryErrorText(outcome.code, outcome.error, "events"));
      return;
    }
    const merged = mergeEventPage(events, outcome.value);
    setEvents(merged.events);
    setNextCursor(merged.nextCursor);
  }, [remote, nextCursor, eventsLoading, query, errorCode, events]);

  return (
    <Suspense fallback={<div className="status-overlay" role="status">正在加载本机遥测…</div>}>
      <TelemetryPage
        query={query}
        {...(errorCode ? { errorCode } : {})}
        status={status}
        statusError={statusError}
        summary={summary}
        anomalies={anomalies}
        events={events}
        {...(nextCursor ? { nextCursor } : {})}
        loading={loading}
        eventsLoading={eventsLoading}
        eventsError={eventsError}
        onChangeQuery={changeQuery}
        onErrorCodeChange={setErrorCode}
        onRefresh={() => void load()}
        onLoadMore={() => void loadMore()}
        onBack={onBack}
        onOpenSettings={onOpenSettings}
      />
    </Suspense>
  );
}
