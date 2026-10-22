/**
 * 任务监控只读查询 adapter（自 `pages/task-monitor/remote.ts` 迁入）
 * （change: 生成溯源改为画布内浮窗）。
 *
 * 独立任务监控页与画布内「生成溯源」浮窗共用同一份协议调用；route 与插件各自把自己的
 * Application transport 传进来。
 *
 * **分层约束**：`shared/` 不得 import `cordis/`（见 `cordis/architecture.test.ts`），因此
 * transport 只按**结构化最小形状**声明（见既有先例 `shared/task-history/client.ts`），
 * 不 import Cordis 的 `ApplicationRemoteTransport` 类型。
 */
import type { TaskExecutionDetail, TaskInspectionSnapshot, TaskHistoryQuery } from "@woohaa3/contracts";

/** 单次 JSON 请求所需的最小 transport 形状（宿主 `ApplicationRemoteTransport.request` 可直接传入）。 */
export type TaskMonitorTransport = {
  request(input: { path: string; method?: "GET" | "POST" | "PUT"; body?: unknown; signal?: AbortSignal }): Promise<TaskMonitorTransportResult>;
};

export type TaskMonitorTransportResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; code: string; error: string; status?: number };

export type TaskMonitorResult<T> = { ok: true; value: T } | { ok: false; code: string; error: string; status?: number };

export type TaskMonitorRemote = {
  snapshot(input: { query?: TaskHistoryQuery; limit?: number; signal?: AbortSignal }): Promise<TaskMonitorResult<TaskInspectionSnapshot>>;
  detail(input: { taskKey: string; signal?: AbortSignal }): Promise<TaskMonitorResult<TaskExecutionDetail>>;
};

const BASE = "/api/task-inspection";

export function createTaskMonitorRemote(deps: { remote: TaskMonitorTransport }): TaskMonitorRemote {
  const call = async <T>(
    route: string,
    body: unknown,
    signal?: AbortSignal
  ): Promise<TaskMonitorResult<T>> => {
    const result: TaskMonitorTransportResult = await deps.remote.request({
      path: `${BASE}/${route}`,
      method: "POST",
      body,
      ...(signal ? { signal } : {})
    });
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        error: result.error,
        ...(result.status !== undefined ? { status: result.status } : {})
      };
    }
    return { ok: true, value: result.data as T };
  };
  return {
    snapshot: (input) =>
      call<TaskInspectionSnapshot>(
        "snapshot",
        {
          ...(input.query ? { query: input.query } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {})
        },
        input.signal
      ),
    detail: (input) => call<TaskExecutionDetail>("detail", { taskKey: input.taskKey }, input.signal)
  };
}
