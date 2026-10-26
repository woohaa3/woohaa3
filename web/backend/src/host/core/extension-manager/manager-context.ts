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
  /**
   * 重载。`hasBackend` = 声明了后端代码（记录里的 `requiresRestart`）：
   * - 纯前端：运行期发布 release 热登记；
   * - 含后端：一律 `restart-required`。C 方向下扩展后端与宿主同进程，没有可并行的第二份实例，
   *   因此不存在蓝绿切换，也没有运行期装配后端插件的路径。
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
    // C 方向：含后端的变化一律要求受控重启。扩展后端与宿主同进程，没有第二份实例可以并行起停，
    // 也没有运行期追加后端插件的路径。浏览器产物仍可热发布，下面继续处理。
    if (hasBackend) return "restart-required";
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
    commit((draft) => {
      const record = draft.extensions[extensionId];
      if (!record) throw new ExtensionManagerError("MARKETPLACE_NOT_INSTALLED", `扩展 ${extensionId} 不是受管扩展`);
      const from = record.current;
      const backend = Boolean(record.requiresRestart);
      const restart = backend;
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
    reload,
    switchPointer
  };
}