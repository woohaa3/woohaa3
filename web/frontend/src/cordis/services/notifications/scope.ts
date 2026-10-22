/**
 * 任务结果通知的数据范围过滤（change: 2026-10-17-move-settings-into-canvas-dialog，任务 7.1 / design D8）。
 *
 * 历史读面在受控部署中要求 operator/admin 身份，因此「管理员可读」**不等于**「希望收到所有人
 * 的任务通知」。规则：
 * - 本地个人实例（`accessControl: false`）：数据空间只有一个主体，全部任务都属于当前使用者；
 * - 受控部署（`accessControl: true`）：只提醒 actor 为当前 subject 的任务；
 *   `actor` 缺失或 `unknown` 的旧记录**不猜归属**，默认不提醒；
 * - 身份未知（session 尚未解析）时不放大范围，也不回退到「全部」。
 *
 * 纯函数，便于确定性回归。
 */
import type { ApplicationSessionSnapshot, TaskExecutionSummary } from "@woohaa3/contracts";

export type NotificationScopeDecision = {
  /** 该记录是否属于当前使用者的通知范围。 */
  accepted: boolean;
  /** 拒绝时的稳定原因（诊断用，不含任务内容）。 */
  reason?: "not-own-task" | "identity-unknown";
};

export function decideNotificationScope(
  session: ApplicationSessionSnapshot | null,
  record: TaskExecutionSummary
): NotificationScopeDecision {
  // 身份未解析：不放大小范围，也不回退成全局。
  if (!session) return { accepted: false, reason: "identity-unknown" };
  // 本地个人实例：单主体数据空间。
  if (session.accessControl === false) return { accepted: true };

  const actor = record.actor;
  // 旧记录/缺少可信受理依据：不反填为查看者，也不提醒。
  if (!actor || actor.unknown === true || typeof actor.subject !== "string" || actor.subject === "") {
    return { accepted: false, reason: "not-own-task" };
  }
  return actor.subject === session.subject
    ? { accepted: true }
    : { accepted: false, reason: "not-own-task" };
}

/**
 * 生成 `accept` 谓词（供 task-source 使用）。
 *
 * session 通过 getter 读取，账号切换后立刻生效；已提醒去重仍由服务持有。
 */
export function scopedAccept(getSession: () => ApplicationSessionSnapshot | null) {
  return (record: TaskExecutionSummary): boolean =>
    decideNotificationScope(getSession(), record).accepted;
}
