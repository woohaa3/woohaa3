/**
 * 受限任务监控 facade
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 7.4/7.5 / design D9/D11）。
 *
 * 只读 durable task history；调用方（宿主）注入 `assertAuthorized(principal)` 在**查询前**执行
 * `tasks.inspect` 站点授权检查。本模块不import 宿主实现、不交出 repository/store 句柄。
 *
 * 快照语义：全局状态计数与过滤列表取自**同一次**查询快照，`observedAt` 为统一时刻；列表受
 * `limit`（默认 100、上限 200）约束并以 Task 的稳定 cursor 分页。
 */
import { computeTaskTiming, TASK_INSPECTION_DEFAULT_LIMIT, TASK_INSPECTION_MAX_LIMIT } from "@woohaa3/contracts";
import type {
  PrincipalContext,
  TaskExecutionDetail,
  TaskInspectionFacade,
  TaskInspectionSnapshot
} from "@woohaa3/contracts";
import type { SqliteTaskHistoryRepository } from "../repository/history-repository.js";

export type TaskInspectionFacadeOptions = {
  accessRuntime?: import("@woohaa3/contracts").AccessRuntime;
  history: SqliteTaskHistoryRepository;
  /**
   * 查询前授权检查（宿主注入 site policy 的 `tasks.inspect` 断言）。抛错即拒绝，不执行查询。
   */
  assertAuthorized: (principal: PrincipalContext) => Promise<void>;
  now?: () => string;
};

/**
 * 从 history 已有的可靠时刻计算生命周期耗时。
 *
 * 受理时间取 `createdAt`（提交即登记），首次执行取 `startedAt`，终态取 `finishedAt`——三者都是
 * 持久化事实，不需要新列。`stateChangedAt` 没有可信来源（`updated_at` 会被任何写入推进），
 * 按契约留空而不是用它猜测，因此「状态驻留」保持未知。
 *
 * 进行中的任务以 `observedAt`（本次快照时刻）作为终点，页面因此能看到实时累计耗时。
 */
function readTaskTiming(detail: TaskExecutionDetail, observedAt: string): TaskExecutionDetail["timing"] {
  return computeTaskTiming({
    state: detail.state,
    admittedAt: detail.createdAt,
    ...(detail.startedAt ? { firstStartedAt: detail.startedAt } : {}),
    ...(detail.finishedAt ? { finishedAt: detail.finishedAt } : {}),
    observedAt
  });
}

export function createTaskInspectionFacade(options: TaskInspectionFacadeOptions): TaskInspectionFacade {
  const now = options.now ?? (() => new Date().toISOString());
  const authorize = async (principal: PrincipalContext | undefined) => {
    if (options.accessRuntime?.enabled === false) return;
    if (!principal) throw Object.assign(new Error("未认证"), { code: "unauthenticated" });
    await options.assertAuthorized(principal);
  };
  return {
    async snapshot({ principal, query, limit }): Promise<TaskInspectionSnapshot> {
      // 授权在 repository 查询**之前**（spec「未授权请求不会查询 repository」）。
      await authorize(principal);
      const boundedLimit = Math.min(
        Math.max(limit ?? query?.limit ?? TASK_INSPECTION_DEFAULT_LIMIT, 1),
        TASK_INSPECTION_MAX_LIMIT
      );
      const observedAt = now();
      const stateCounts = options.history.countStates();
      const result = options.history.list({ ...(query ?? {}), limit: boundedLimit });
      if (!result.ok) {
        // 稳定查询错误（cursor 错配等）：返回空列表 + 计数，由页面提示重新筛选，不抛 500。
        return { observedAt, stateCounts, items: [], nextCursor: null };
      }
      const items = result.page.items.map((summary) => {
        const detail = options.history.get(summary.taskKey) ?? ({ ...summary, events: [] } as TaskExecutionDetail);
        return { ...detail, timing: readTaskTiming(detail, observedAt) };
      });
      const snapshot: TaskInspectionSnapshot = {
        observedAt,
        stateCounts,
        items,
        nextCursor: result.page.nextCursor ?? null
      };
      return snapshot;
    },
    async detail({ principal, taskKey }): Promise<TaskExecutionDetail | null> {
      await authorize(principal);
      const detail = options.history.get(taskKey, { includeRequest: true });
      return detail ? { ...detail, timing: readTaskTiming(detail, now()) } : null;
    }
  };
}
