/**
 * Extension Manager 的闭包共享状态：一次 `createExtensionManager` 构造一个上下文，
 * 安装流水线与生命周期函数都通过它显式取用依赖与状态（不引入模块级可变状态）。
 */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionInstallOutcome } from "@woohaa3/contracts";
import { ExtensionManagerError, toManagerError } from "./errors.js";
import { createJobBoard, type Job, type JobBoard } from "./jobs.js";
import {
  DEFAULT_MAX_PACKAGE_BYTES,
  DEFAULT_OBSERVE_MS,
  DEFAULT_RETENTION_MS,
  FAILURE_MESSAGES,
  sleepDefault,
  type ExtensionIsolationPort,
  type ExtensionManagerDeps
} from "./manager-types.js";
import type { ExtensionPackageToolkit, InstallationRecord, InstallationsHandle, InstallationsState } from "./types.js";

export type ManagerContext = {
  deps: ExtensionManagerDeps;
  handle: InstallationsHandle | null;
  toolkit: ExtensionPackageToolkit;
  now: () => Date;
  log: (event: Record<string, unknown>) => void;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxPackageBytes: number;
  observeMs: number;
  failureThreshold: number;
  retentionMs: number;
  drainTimeoutMs: number;
  drainPollMs: number;
  board: JobBoard;
  healthFailures: Map<string, number>;
  /** 本进程内需要重启才生效的扩展（卸载含后端的扩展后记录已删，靠这里提示）。 */
  restartPendingRemoved: Set<string>;
  /** 每个 Manager 实例自己的可变状态。 */
  status: { closed: boolean };
  requireHandle(): InstallationsHandle;
  /** 提交一次指针变更：读当前 revision → mutator → 原子写。 */
  commit(mutate: (draft: InstallationsState) => void): InstallationsState;
  history(record: InstallationRecord, entry: Record<string, unknown>): InstallationRecord;
  stagingFor(job: Job): string;
  cleanupStaging(job: Job): void;
  assertNotAborted(job: Job): void;
  /** 隔离端口（缺省 = 隔离关闭，P1 受控重启语义）。 */
  isolation: ExtensionIsolationPort | null;
  /**
   * 含后端代码的扩展能否不重启生效（D10 / 任务 8.4）：已由子进程托管（升级走 swap），或隔离服务支持
   * 运行期装配（首次安装走 attach）。隔离关闭时为 false（P1 受控重启）。
   */
  hotSwappable(extensionId: string): boolean;
  /**
   * 重载。`hasBackend` = 声明了后端代码（记录里的 `requiresRestart`）：
   * - 纯前端：运行期发布 release 热登记；
   * - 含后端且 `hotSwappable`：蓝绿切换到 `directory`（失败 `MARKETPLACE_SWAP_FAILED`，蓝不动），之后再热登记前端产物；
   * - 含后端但不能热切换（隔离关闭 / 首次安装还没有子进程托管）：`restart-required`。
   * `directory = null` 表示卸载。
   */
  reload(extensionId: string, directory: string | null, hasBackend: boolean): Promise<ExtensionInstallOutcome>;
  /** 把指针切到 target（安装后重载失败 / 观察期失败 / 手动回滚共用）。`backend` = 含后端代码；`restart` = 需要受控重启才生效。 */
  switchPointer(extensionId: string, target: string, action: string, actor: string, rejected?: string): { record: InstallationRecord | null; restart: boolean; backend: boolean };
};

export function createManagerContext(deps: ExtensionManagerDeps, handle: InstallationsHandle | null): ManagerContext {
  const now = deps.now ?? (() => new Date());
  const log = deps.logger ?? (() => undefined);
  const sleep = deps.sleep ?? sleepDefault;
  const { toolkit } = deps;
  const maxPackageBytes = deps.limits?.maxPackageBytes ?? DEFAULT_MAX_PACKAGE_BYTES;
  const observeMs = deps.observeMs ?? DEFAULT_OBSERVE_MS;
  const failureThreshold = deps.observeFailureThreshold ?? 3;
  const retentionMs = deps.retentionMs ?? DEFAULT_RETENTION_MS;
  const drainTimeoutMs = deps.drainTimeoutMs ?? 5 * 60 * 1000;
  const drainPollMs = deps.drainPollMs ?? 1000;
  const board = createJobBoard({ now });
  const healthFailures = new Map<string, number>();
  const restartPendingRemoved = new Set<string>();
  const isolation: ExtensionIsolationPort | null = deps.isolation ?? null;
  const isolatedNow = (extensionId: string): boolean => {
    try {
      return isolation?.isolated(extensionId) === true;
    } catch {
      return false;
    }
  };
  const canAttach = (): boolean => {
    if (typeof isolation?.attach !== "function") return false;
    try {
      return isolation.canAttach ? isolation.canAttach() : true;
    } catch {
      return false;
    }
  };
  const hotSwappable = (extensionId: string): boolean => isolatedNow(extensionId) || canAttach();

  const requireHandle = (): InstallationsHandle => {
    if (!handle) throw new ExtensionManagerError("MARKETPLACE_UNAVAILABLE", FAILURE_MESSAGES.MARKETPLACE_UNAVAILABLE!);
    return handle;
  };

  /** 提交一次指针变更：读当前 revision → mutator → 原子写。 */
  const commit = (mutate: (draft: InstallationsState) => void): InstallationsState => {
    const h = requireHandle();
    const current = h.read();
    try {
      return h.commit((draft) => {
        mutate(draft);
      }, { expectedRevision: current.revision });
    } catch (error) {
      throw toManagerError(error, "MARKETPLACE_REVISION_CONFLICT");
    }
  };

  const history = (record: InstallationRecord, entry: Record<string, unknown>): InstallationRecord =>
    toolkit.appendHistory(record, { ...entry, at: now().toISOString() });

  const stagingFor = (job: Job) => path.join(requireHandle().layout.stagingDir, job.id);
  const cleanupStaging = (job: Job) => {
    if (!handle) return;
    fs.rmSync(stagingFor(job), { recursive: true, force: true });
  };

  const assertNotAborted = (job: Job) => {
    if (job.controller.signal.aborted) throw new ExtensionManagerError("MARKETPLACE_CANCELLED", "安装已取消");
  };

  const reload = async (extensionId: string, directory: string | null, hasBackend: boolean): Promise<ExtensionInstallOutcome> => {
    if (hasBackend) {
      if (!hotSwappable(extensionId)) return "restart-required";
      // 卸载：站点已停用（lifecycle.uninstall 先 disableSite）。运行期装配的扩展整体撤下（控制面 / 门禁 /
      // 扩展层 / 子进程），启动期装配的只停子进程（占位保留到下次启动）。
      if (!directory) {
        try {
          if (isolation!.detach) await isolation!.detach(extensionId);
          else await isolation!.remove?.(extensionId);
        } catch (error) {
          log({ event: "extension-host-remove-failed", extensionId, message: error instanceof Error ? error.message : String(error) });
        }
      } else if (!isolatedNow(extensionId)) {
        // 首次安装（本进程还没有代理插件）：运行期装配并等就绪（任务 8.4）。
        try {
          const result = await isolation!.attach!(extensionId, directory, path.basename(directory));
          log({ event: "extension-attached", extensionId, directory, state: result.state });
        } catch (error) {
          const cause = (error as { code?: unknown })?.code;
          const message = error instanceof Error ? error.message : String(error);
          throw new ExtensionManagerError("MARKETPLACE_SWAP_FAILED", `新扩展未能在独立进程中就绪${typeof cause === "string" ? `（${cause}）` : ""}：${message}`);
        }
      } else {
        try {
          const result = await isolation!.swap(extensionId, directory);
          log({ event: result.swapped ? "extension-swapped" : "extension-swap-noop", extensionId, directory });
        } catch (error) {
          const code = (error as { code?: unknown })?.code;
          const cause = (error as { cause?: { code?: unknown; message?: unknown } })?.cause;
          const reason = typeof cause?.code === "string" ? `（${cause.code}）` : "";
          const message = error instanceof Error ? error.message : String(error);
          if (code === "MARKETPLACE_NOT_INSTALLED") throw new ExtensionManagerError("MARKETPLACE_SWAP_FAILED", `扩展 ${extensionId} 没有子进程托管，无法切换：${message}`);
          throw new ExtensionManagerError("MARKETPLACE_SWAP_FAILED", `新版本未能在独立进程中就绪${reason}：${message}`);
        }
      }
      if (!deps.publishBrowserRelease) return "installed";
    }
    if (!deps.publishBrowserRelease) return "restart-required";
    try {
      await deps.publishBrowserRelease(directory ? { upsert: [{ extensionId, directory }] } : { remove: [extensionId] });
    } catch (error) {
      const failure = toManagerError(error, "MARKETPLACE_PREFLIGHT_FAILED");
      throw new ExtensionManagerError("MARKETPLACE_PREFLIGHT_FAILED", `发布浏览器产物失败：${failure.message}`);
    }
    return "installed";
  };

  /** 把指针切回 previous（安装后重载失败 / 观察期失败 / 手动回滚共用）。返回切换后的记录与是否需重启。 */
  const switchPointer = (extensionId: string, target: string, action: string, actor: string, rejected?: string) => {
    let result: { record: InstallationRecord | null; restart: boolean; backend: boolean } = { record: null, restart: false, backend: false };
    const swappable = hotSwappable(extensionId);
    commit((draft) => {
      const record = draft.extensions[extensionId];
      if (!record) throw new ExtensionManagerError("MARKETPLACE_NOT_INSTALLED", `扩展 ${extensionId} 不是受管扩展`);
      const from = record.current;
      const backend = Boolean(record.requiresRestart);
      const restart = backend && !swappable;
      let next: InstallationRecord = {
        ...record,
        current: target,
        previous: from === target ? record.previous ?? null : from,
        state: "active",
        observeUntil: null,
        observeAfterRestart: false,
        restartPending: restart || record.restartPending === true,
        ...(rejected ? { rejected: [...new Set([...(record.rejected ?? []), rejected])] } : {})
      };
      next = history(next, { revision: draft.revision + 1, action, version: target, from, actor });
      draft.extensions[extensionId] = next;
      result = { record: next, restart, backend };
    });
    return result;
  };

  return {
    deps,
    handle,
    toolkit,
    now,
    log,
    sleep,
    maxPackageBytes,
    observeMs,
    failureThreshold,
    retentionMs,
    drainTimeoutMs,
    drainPollMs,
    board,
    healthFailures,
    restartPendingRemoved,
    status: { closed: false },
    requireHandle,
    commit,
    history,
    stagingFor,
    cleanupStaging,
    assertNotAborted,
    isolation,
    hotSwappable,
    reload,
    switchPointer
  };
}