/**
 * 崩溃熔断的隔离记录（change: 2026-10-21-isolate-extension-host-process，D7）。
 *
 * 事实源是审计记录：进入 / 解除各写一条运维事件（`config-store.recordEvent`），重启时取每个扩展**最近一条**
 * 隔离事件恢复——实际状态表会被停用等操作覆盖，不能当事实源。本模块是它的内存视图。
 * 隔离**不改写** desiredEnabled；解除后按 desiredEnabled 重新协调。
 *
 * 投影优先级（statusFor）：
 *   安全模式 suspended  >  停用 disabled/draining（desiredEnabled=false）  >  quarantined  >  failed  >  configuring  >  degraded/active
 * - 安全模式下扩展根本不装配，不会再崩溃；保留的隔离记录在退出安全模式后重新生效。
 * - 管理员停用优先：停用是人的决定，显示 disabled；隔离记录保留，重新启用后仍是 quarantined，不会激活。
 */
import type { ApplicationExtensionSafeDiagnostic } from "@woohaa3/contracts";
import { EXTENSION_CRASH_LOOP_DIAGNOSTIC } from "@woohaa3/contracts";

export type QuarantineRecord = { diagnostic: ApplicationExtensionSafeDiagnostic; since: string };

export type QuarantineRegistry = {
  /** 运行期新增扩展时，从审计恢复它的隔离记录（与启动期同一规则）。 */
  restore(extensionId: string): void;
  get(extensionId: string): QuarantineRecord | undefined;
  has(extensionId: string): boolean;
  set(extensionId: string, record: QuarantineRecord): void;
  delete(extensionId: string): boolean;
};

/** 规范化诊断：缺省为 crash-loop；消息截断，防止把子进程输出整段写进公开状态。 */
export function quarantineDiagnostic(input?: Partial<ApplicationExtensionSafeDiagnostic>): ApplicationExtensionSafeDiagnostic {
  const code = typeof input?.code === "string" && input.code.length > 0 ? input.code.slice(0, 64) : EXTENSION_CRASH_LOOP_DIAGNOSTIC;
  const raw = typeof input?.message === "string" && input.message.length > 0 ? input.message : "短时间内多次崩溃，已停止自动重启";
  return { code, message: raw.length > 200 ? `${raw.slice(0, 199)}…` : raw };
}

type AuditLike = { summary: { event?: string; diagnosticCode?: string }; occurredAt: string };

/** 从审计恢复：`auditOf(id)` 按新到旧返回；最近一条隔离事件是 quarantined 即恢复为隔离。 */
export function createQuarantineRegistry(extensionIds: Iterable<string>, auditOf: (extensionId: string) => readonly AuditLike[]): QuarantineRegistry {
  const records = new Map<string, QuarantineRecord>();
  const restore = (extensionId: string) => {
    const latest = auditOf(extensionId).find((entry) => entry.summary.event === "quarantined" || entry.summary.event === "unquarantined");
    if (latest?.summary.event === "quarantined") {
      records.set(extensionId, {
        diagnostic: quarantineDiagnostic({ code: latest.summary.diagnosticCode ?? EXTENSION_CRASH_LOOP_DIAGNOSTIC }),
        since: latest.occurredAt
      });
    }
  };
  for (const extensionId of extensionIds) restore(extensionId);
  return {
    restore,
    get: (extensionId) => records.get(extensionId),
    has: (extensionId) => records.has(extensionId),
    set: (extensionId, record) => void records.set(extensionId, record),
    delete: (extensionId) => records.delete(extensionId)
  };
}