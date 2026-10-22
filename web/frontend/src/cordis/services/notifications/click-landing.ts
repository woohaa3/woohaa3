/**
 * 通知点击落地（change: 2026-10-17-move-settings-into-canvas-dialog，任务 8.4 / design D9）。
 *
 * 原生侧只回传已校验的稳定身份；这里把它映射成既有 App Router 的 task-history 位置：
 * - 单任务目标 → 按 taskKey（必要时带 canvasId/nodeId）定位历史详情；
 * - 合并通知、非法或失效目标 → 落到历史列表，由历史页给出明确的未找到反馈；
 * - 测试通知 → 不导航，也不产生任务事实。
 *
 * 不构造任意 URL、不打开外部地址，也不创建任务。
 */

/** 只含稳定身份的点击目标（不含 prompt、参数、媒体地址或任意 URL）。 */
export type NotificationClickTarget = {
  taskKey: string;
  canvasId?: string;
  nodeId?: string;
};

export type NotificationClick = {
  /** 测试通知的点击只用于确认通道可用。 */
  test: boolean;
  target: NotificationClickTarget | null;
};

export type NotificationClickLocation = {
  page: "task-history";
  history: { taskKey?: string; canvasId?: string; nodeId?: string };
};

/** 返回 `null` 表示这次点击不应产生导航。 */
export function notificationClickLocation(
  click: NotificationClick
): NotificationClickLocation | null {
  if (click.test) return null;
  const target = click.target;
  return {
    page: "task-history",
    history: target
      ? {
          taskKey: target.taskKey,
          ...(target.canvasId ? { canvasId: target.canvasId } : {}),
          ...(target.nodeId ? { nodeId: target.nodeId } : {})
        }
      : {}
  };
}
