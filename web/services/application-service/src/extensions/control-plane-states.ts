/**
 * 控制面的「暂停态」：安全模式 `suspended` 与崩溃熔断 `quarantined`（从 control-plane.ts 拆出）。
 *
 * - suspended（change: 2026-10-21-harden-extension-fault-isolation，D7）：启动期安全模式集合，不激活、不改写 desiredEnabled；
 * - quarantined（change: 2026-10-21-isolate-extension-host-process，D7）：崩溃熔断，事实源是审计（见 quarantine.ts）。
 *
 * 两者都只影响「已启用」的扩展；同时存在时 suspended 优先（安全模式下扩展根本不装配）。
 */
import type { ApplicationExtensionActualState, ApplicationExtensionSafeDiagnostic, ApplicationExtensionStatus } from "@woohaa3/contracts";
import type { SqliteSiteExtensionConfigStore } from "./config-store.js";
import type { SiteExtensionMetadataSource, SiteExtensionQuarantineOutcome } from "./control-plane-types.js";
import { quarantineDiagnostic, type QuarantineRegistry } from "./quarantine.js";

export const SAFE_MODE_DIAGNOSTIC: ApplicationExtensionSafeDiagnostic = { code: "safe-mode", message: "安全模式下已暂停" };

export type HeldState = { actualState: "suspended" | "quarantined"; diagnostics: ApplicationExtensionSafeDiagnostic[] };

/** 已启用扩展当前是否被暂停（不激活）；null 表示可正常激活。 */
export function heldStateOf(extensionId: string, suspended: ReadonlySet<string>, quarantine: QuarantineRegistry): HeldState | null {
  if (suspended.has(extensionId)) return { actualState: "suspended", diagnostics: [SAFE_MODE_DIAGNOSTIC] };
  const isolated = quarantine.get(extensionId);
  return isolated ? { actualState: "quarantined", diagnostics: [isolated.diagnostic] } : null;
}

type QuarantineDeps = {
  metadata: SiteExtensionMetadataSource;
  store: SqliteSiteExtensionConfigStore;
  quarantine: QuarantineRegistry;
  now: () => Date;
  log: (event: Record<string, unknown>) => void;
  statusFor: (extensionId: string) => ApplicationExtensionStatus | undefined;
  /** 释放 public 实例与无引用旧版本（进程已死，解除隔离时才能真正重新激活）。 */
  release: (extensionId: string) => Promise<void>;
  /** 只协调这一个扩展（解除隔离后按 desiredEnabled 恢复）。 */
  reconcileOne: (extensionId: string) => Promise<void>;
};

export function createQuarantineOperations(deps: QuarantineDeps) {
  const notFound = (extensionId: string): SiteExtensionQuarantineOutcome => ({
    ok: false,
    code: "extension-not-found",
    message: `插件 ${extensionId} 不在可信清单中`
  });
  const unchanged = (extensionId: string): SiteExtensionQuarantineOutcome => ({
    ok: true,
    revision: deps.store.revision(),
    status: deps.statusFor(extensionId)!,
    changed: false
  });

  const quarantine = async (
    extensionId: string,
    diagnostic?: Partial<ApplicationExtensionSafeDiagnostic>,
    actor = "system:extension-host"
  ): Promise<SiteExtensionQuarantineOutcome> => {
    if (!deps.metadata.get(extensionId)) return notFound(extensionId);
    if (deps.quarantine.has(extensionId)) return unchanged(extensionId);
    const timestamp = deps.now().toISOString();
    const record = { diagnostic: quarantineDiagnostic(diagnostic), since: timestamp };
    deps.quarantine.set(extensionId, record);
    try {
      await deps.release(extensionId);
    } catch (error) {
      deps.log({ event: "site-extension-quarantine-release-failed", extensionId, message: error instanceof Error ? error.message : String(error) });
    }
    deps.store.setActual(extensionId, "quarantined", [record.diagnostic], timestamp);
    const revision = deps.store.recordEvent({ extensionId, actor, event: "quarantined", diagnosticCode: record.diagnostic.code, now: timestamp });
    deps.log({ event: "site-extension-quarantined", extensionId, code: record.diagnostic.code });
    return { ok: true, revision, status: deps.statusFor(extensionId)!, changed: true };
  };

  const unquarantine = async (extensionId: string, actor = "system:extension-host"): Promise<SiteExtensionQuarantineOutcome> => {
    if (!deps.metadata.get(extensionId)) return notFound(extensionId);
    if (!deps.quarantine.has(extensionId)) return unchanged(extensionId);
    deps.quarantine.delete(extensionId);
    deps.store.recordEvent({ extensionId, actor, event: "unquarantined", now: deps.now().toISOString() });
    deps.log({ event: "site-extension-unquarantined", extensionId });
    // 按 desiredEnabled 重新协调：启用的重新激活，停用的保持停用。
    await deps.reconcileOne(extensionId);
    return { ok: true, revision: deps.store.revision(), status: deps.statusFor(extensionId)!, changed: true };
  };

  return { quarantine, unquarantine };
}

/**
 * prepare 候选配置：只接受已校验的非秘密值与 opaque secret reference，且不允许 URL/data 载体。
 * 真正的资源准备（如打开连接）由插件 activation 完成；这里保证候选本身可安全提交。
 * （从 control-plane.ts 原样移出。）
 */
export function prepareCandidate(extensionId: string, values: Record<string, unknown>, secretRefs: readonly string[]): void {
  void extensionId;
  for (const ref of secretRefs) {
    const lower = ref.toLowerCase();
    if (lower.includes("://") || lower.startsWith("data:") || lower.startsWith("blob:")) {
      throw new Error("secret reference 不得是 URL/data/blob 载体");
    }
  }
  const serialized = JSON.stringify(values);
  if (serialized !== undefined && serialized.length > 64 * 1024) {
    throw new Error("候选配置超出大小上限");
  }
}
const ACTUAL_TO_DIAGNOSTIC: Partial<Record<ApplicationExtensionActualState, string>> = {
  failed: "插件激活失败",
  suspended: "安全模式下已暂停",
  quarantined: "短时间内多次崩溃，已停止自动重启",
  degraded: "插件处于降级状态",
  unconfigured: "插件尚未配置"
};

/** 实际状态没有自带诊断时的缺省诊断（从 control-plane.ts 原样移出）。 */
export function fallbackDiagnostics(store: SqliteSiteExtensionConfigStore, extensionId: string): ApplicationExtensionSafeDiagnostic[] {
  const actual = store.actual(extensionId);
  if (actual && actual.diagnostics.length > 0) return actual.diagnostics;
  const state = actual?.actualState;
  if (state && ACTUAL_TO_DIAGNOSTIC[state]) {
    return [{ code: state, message: ACTUAL_TO_DIAGNOSTIC[state] as string }];
  }
  if (!store.get(extensionId)) {
    return [{ code: "unconfigured", message: "插件尚未配置" }];
  }
  return [];
}
