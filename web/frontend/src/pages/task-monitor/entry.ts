/**
 * 内置任务监控的宿主页面动作。
 *
 * 监控页本身是独立 app/page（`/admin/tasks`）。这里只提供**页面动作**（`openTaskInspection`），
 * 供执行面板等宿主入口按 `tasks.inspect` 导航；画布工具栏不注册任务监控按钮。
 */
import type { Context } from "@deepseek-ai/cordis";
import { OPEN_TASK_INSPECTION_ACTION, TASKS_INSPECT_ACTION } from "@woohaa3/contracts";

type SiteAccess = { hasAction(action: string): boolean };

export function installTaskMonitorAction(ctx: Context): void {
  const access = ctx.get("siteAccessCapability" as never) as SiteAccess | undefined;
  // 每次调用都读取当前资格：权限变化无需订阅，也不需要工具栏入口的增删。
  const available = () => access?.hasAction(TASKS_INSPECT_ACTION) ?? false;
  // `taskKey` 供「查看生成溯源」直接从画布产物打开上游任务详情（change: l0-generation-provenance）；
  // 缺失时按 canvasId + nodeId 筛选列表。
  const open = (input?: { canvasId?: string; nodeId?: string; taskKey?: string }) => {
    if (!available()) return;
    ctx.appRouter.navigate({ page: "task-monitor", query: { ...input } });
  };
  ctx.provide(OPEN_TASK_INSPECTION_ACTION as never, { open, available } as never);
}
