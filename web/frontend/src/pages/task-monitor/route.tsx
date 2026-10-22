/** 宿主内置的任务监控页面；不依赖扩展发布目录或站点插件状态。 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { TaskHistoryQuery } from "@woohaa3/contracts";
import type { ExtensionAppPageQuery } from "@woohaa3/contracts";
import { useRuntimeContext } from "../../cordis/react.js";
import { decodeTaskMonitorSearch, encodeTaskMonitorSearch } from "./query.js";
import { createTaskMonitorRemote } from "./remote.js";
import { TaskMonitorPage } from "./task-monitor.js";

export function taskMonitorQueryFromPage(query: ExtensionAppPageQuery): { query: TaskHistoryQuery; taskKey?: string; opaqueCursor: boolean } {
  const decoded = decodeTaskMonitorSearch(new URLSearchParams(query));
  return decoded.ok ? decoded.value : { query: {}, opaqueCursor: false };
}

export function pageQueryFromTaskMonitor(input: { query: TaskHistoryQuery; taskKey?: string }): ExtensionAppPageQuery {
  return Object.fromEntries(encodeTaskMonitorSearch(input));
}

export function TaskMonitorRoute() {
  const ctx = useRuntimeContext();
  const router = ctx.appRouter;
  const access = ctx.currentUser;
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    let active = true;
    void access.initialize().catch(() => undefined).finally(() => { if (active) setInitialized(true); });
    return () => { active = false; };
  }, [access]);
  const session = useSyncExternalStore(access.subscribe, access.getSnapshot, access.getSnapshot);
  const location = useSyncExternalStore(router.subscribe, router.getLocation, router.getLocation);
  const remote = useMemo(() => createTaskMonitorRemote({ remote: ctx.applicationRemote.transport }), [ctx]);
  const decoded = taskMonitorQueryFromPage(location.query ?? {});
  if (!session) return <div className="status-overlay">{initialized ? "无法确认身份，请登录或刷新重试。" : "正在确认身份…"}</div>;
  if (!access.hasAction("tasks.inspect")) return <div className="status-overlay">没有任务监控权限。</div>;
  return (
    <TaskMonitorPage
      remote={remote}
      appliedQuery={decoded.query}
      {...(decoded.taskKey ? { selectedTaskKey: decoded.taskKey } : {})}
      onQueryChange={(next) => {
        const target = { page: "task-monitor" as const, query: pageQueryFromTaskMonitor(next) };
        if (next.replace) router.replace(target);
        else router.navigate(target);
      }}
      onOpenCanvas={({ canvasId, nodeId }) => router.navigate({ page: "canvas", canvasId, ...(nodeId ? { nodeId } : {}) })}
      resolveMediaUrl={(key, canvasId) => ctx.mediaRemote.urlFor(key, canvasId)}
    />
  );
}
